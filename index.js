    import express from "express";
    import { dirname, join } from "path";
    import { fileURLToPath } from "url";
    import axios from "axios";
    import dotenv from "dotenv";
    import moment from "moment";
    import session from "express-session"
    import path from "path";
    import fs from "fs";
    import winston from "winston";

    dotenv.config();

    const app = express();
    const port = process.env.PORT || 3000;
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const tokenFilePath = path.join(__dirname, 'accessToken.json');

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.set('view engine', 'ejs');
    app.set('views', join(__dirname, 'views'));
    app.use(express.static('public'));

    app.use(session({
        secret:'Adarsh',
        resave:false,
        saveUninitialized:true,
        cookie:{secure:false},
        maxAge: 1000 * 60 * 60 * 24
    }));

    // app.use(session({
    //     secret: process.env.SESSION_SECRET || 'Adarsh',
    //     resave: false,
    //     saveUninitialized: false,
    //     cookie: {
    //         secure: process.env.NODE_ENV === 'production', 
    //         httpOnly: true,
    //         maxAge: 24 * 60 * 60 * 1000
    //     }
    // }));

    const logger = winston.createLogger({
        level: 'info',
        format: winston.format.json(),
        transports: [
            new winston.transports.Console({ format: winston.format.simple() })
        ],
    });

    function isAuthenticated(req, res, next) {
        if (req.session.loggedIn) {
            return next();
        } else {
            res.redirect('/');
        }
    }

    let cachedData = null; 
    let cacheTime = null; 
    const CACHE_EXPIRATION = 600;

    const BrandDailyData = new Map();

    function buildRevenueCohorts(data) {
        const BrandMonthlyData = new Map();
        const MonthlyTotals = new Map();

        data.forEach(({ Name, Date, Revenue, Quantity, Volume }) => {
            const orderDate = moment(Date, "DD-MMM-YYYY");
            const MonthKey = orderDate.format("YYYY-MM");
            if (!BrandMonthlyData.has(Name)) {
                BrandMonthlyData.set(Name, new Map());
            }
            // if (!BrandDailyData.has(Name))  {
            //     BrandDailyData.set(Name, new Map());
            // }
        
            const volume = parseFloat(Volume);
            const BrandData = BrandMonthlyData.get(Name);        
            const currentRevenue = BrandData.get(MonthKey) ? BrandData.get(MonthKey).revenue : 0;
            const currentQuantity = BrandData.get(MonthKey) ? BrandData.get(MonthKey).quantity : 0;

            BrandData.set(MonthKey, {
                revenue: currentRevenue + parseFloat(Revenue),
                quantity: currentQuantity + parseInt(Quantity, 10),
                customers: new Set()
            });

            BrandData.get(MonthKey).customers.add(Name); 

            const monthlyTotal = MonthlyTotals.get(MonthKey) || { revenue: 0, quantity: 0, customers: new Set(), volumes: new Map()};
            
            monthlyTotal.customers.add(Name);

            MonthlyTotals.set(MonthKey, {
                revenue: monthlyTotal.revenue + parseFloat(Revenue),
                quantity: monthlyTotal.quantity + parseInt(Quantity, 10),
                customers: monthlyTotal.customers,
                volumes: monthlyTotal.volumes
            });

            if (volume) {
                const volumeMap = monthlyTotal.volumes;
                const currentVolumeQty = volumeMap.get(volume) || 0;
                volumeMap.set(volume, currentVolumeQty + parseInt(Quantity, 10));
            }
        });

        const sortedUniqueMonths = Array.from(MonthlyTotals.keys()).sort();
        return { BrandMonthlyData, sortedUniqueMonths, MonthlyTotals };
    }

    function buildDailyRevenueCohorts(data, month, customerDictionary, Names) {

        // const currentMonth = new Date();
        const Month = month || "2024-11";
        const DailyTotals = new Map();
        const [year, monthNum] = Month.split('-').map(Number) || now.split('-').map(Number);
        const startOfMonth = moment(`${year}-${monthNum}`, "YYYY-MM").startOf('month');
        const endOfMonth = moment(`${year}-${monthNum}`, "YYYY-MM").endOf('month');
        const lastOrderDates = new Map();
        const daysSinceLastOrder = {};
        const BrandDailyData = new Map();
        const orderCounts = new Map();
        Names.forEach(name=>{
            if (name) {
                const trimmedname = name.trim();
                if (customerDictionary[trimmedname]?.CustomerStatus === 'Active') {
                    if (!BrandDailyData.has(name)) {
                        BrandDailyData.set(name, new Map());
                    }
                    if (!orderCounts.has(trimmedname)) {
                        orderCounts.set(trimmedname, 0);
                    }
                }
            }
        });
        data.forEach(({ Name, Date, Revenue, Quantity }) => {    
            if(Name){
                if(customerDictionary[Name.trim()].CustomerStatus==='Active')
                {
                const trimmedName = Name.trim();
                const orderDate = moment(Date, "DD-MMM-YYYY");
                if (!lastOrderDates.has(Name) || orderDate.isAfter(lastOrderDates.get(Name))) {
                    lastOrderDates.set(Name, orderDate);
                }

                lastOrderDates.forEach((lastOrderDate, customerName) => {
                    const daysDiff = moment().diff(lastOrderDate, 'days');
                    daysSinceLastOrder[customerName] = daysDiff;
                });
                if (!orderDate.isBetween(startOfMonth, endOfMonth, null, '[]')) return;

                const DayKey = orderDate.format("DD-MM-YYYY");
                const BrandData = BrandDailyData.get(Name);
                const currentRevenue = BrandData.get(DayKey) ? BrandData.get(DayKey).revenue : 0;

                if (!BrandData.has(DayKey)) {
                    orderCounts.set(trimmedName, orderCounts.get(trimmedName) + 1);
                }

                BrandData.set(DayKey, {
                    revenue: currentRevenue + parseFloat(Revenue),
                    quantity: (BrandData.get(DayKey)?.quantity || 0) + parseInt(Quantity, 10),
                });

                const dailyTotal = DailyTotals.get(DayKey) || { revenue: 0, quantity: 0 };
                DailyTotals.set(DayKey, {
                    revenue: dailyTotal.revenue + parseFloat(Revenue),
                    quantity: dailyTotal.quantity + parseInt(Quantity, 10)
                });
            }
        }
        });

        const sortedUniqueDays = Array.from(DailyTotals.keys()).sort(); 
        return { BrandDailyData, sortedUniqueDays, DailyTotals, daysSinceLastOrder, orderCounts };
    }

    function buildWeeklyCohorts(data, year, names) {
        const weeklyData = new Map();
        const weeklyTotal = {};
        const startOfYear = moment(`${year}-01-01`);
        const endOfYear = moment(`${year}-12-31`);

        data.forEach(({ Name, Quantity, Date }) => {
            const orderDate = moment(Date, 'DD-MMM-YYYY');
            if (!orderDate.isBetween(startOfYear, endOfYear, null, '[]')) return;

            const weekNumber = orderDate.isoWeek();
            const weekKey = `Week ${weekNumber}`;

            if (!weeklyData.has(weekKey)) {
                weeklyData.set(weekKey, {
                    brands: new Map(),
                    startOfWeek: orderDate.clone().startOf('isoWeek'),
                    endOfWeek: orderDate.clone().endOf('isoWeek')
                });
                weeklyTotal[weekKey] = 0;
            }
            
            const weekEntry = weeklyData.get(weekKey);
            const { brands } = weekEntry;
            
            names.forEach(name => {
                if (!brands.has(name)) {
                    brands.set(name, 0);
                }
            });

            const quantity = parseInt(Quantity, 10) || 0;
            brands.set(Name, (brands.get(Name) || 0) + quantity);
            weeklyTotal[weekKey] += quantity;
        });
    
        const BrandWeeklyData = Array.from(weeklyData.entries()).map(([week, { brands, startOfWeek, endOfWeek }]) => {
            const formattedRange = `${startOfWeek.format('MMM D')} - ${endOfWeek.format('MMM D')}`;
            const orderedBrands = Array.from(brands.entries());
            return {
                week,
                brands: orderedBrands,
                dateRange: formattedRange
            };
        });
        return {
            BrandWeeklyData,
            sortedUniqueWeeks: Array.from(weeklyData.keys()),
            weeklyTotal,
        };
    }

    function buildWeeklyCohortsWithBrandWeeks(data, year, names) {
        const weeklyData = new Map();
        const startOfYear = moment(`${year}-01-01`);
        const endOfYear = moment(`${year}-12-31`);

        data.forEach(({ Name, Quantity, Date }) => {
            const orderDate = moment(Date, 'DD-MMM-YYYY');
            if (!orderDate.isBetween(startOfYear, endOfYear, null, '[]')) return;

            const weekNumber = orderDate.isoWeek();
            const weekKey = `Week ${weekNumber}`;

            if (!weeklyData.has(weekKey)) {
                weeklyData.set(weekKey, {
                    brands: new Map(),
                    startOfWeek: orderDate.clone().startOf('isoWeek'),
                    endOfWeek: orderDate.clone().endOf('isoWeek')
                });
            }

            const weekEntry = weeklyData.get(weekKey);
            const { brands } = weekEntry;

            if (!brands.has(Name)) {
                brands.set(Name, {
                    Week: [],   
                    Quantity: []   
                });
            }

            const quantity = parseInt(Quantity, 10) || 0;
            const brandData = brands.get(Name);
            const weekIndex = brandData.Week.indexOf(weekKey);
            
            if (weekIndex === -1) {
                brandData.Week.push(weekKey);
                brandData.Quantity.push(quantity);
            } else {
                brandData.Quantity[weekIndex] += quantity;
            }
        });

        const BrandWeeklyData = {};

        weeklyData.forEach((weekData) => {
            weekData.brands.forEach((brandData, brandName) => {
                if (!BrandWeeklyData[brandName]) {
                    BrandWeeklyData[brandName] = {
                        Week: [],
                        Quantity: []
                    };
                }

                brandData.Week.forEach((week, index) => {
                    const weekIndex = BrandWeeklyData[brandName].Week.indexOf(week);
                    if (weekIndex === -1) {
                        BrandWeeklyData[brandName].Week.push(week);
                        BrandWeeklyData[brandName].Quantity.push(brandData.Quantity[index]);
                    } else {
                        BrandWeeklyData[brandName].Quantity[weekIndex] += brandData.Quantity[index];
                    }
                });
            });
        });

        return {
            BrandWeeklyData
            // sortedUniqueWeeks: Array.from(weeklyData.keys())
        };
    }

    function buildWeeklyChartRevenue(data, year, names) {
        const weeklyData = new Map();
        const startOfYear = moment(`${year}-01-01`);
        const endOfYear = moment(`${year}-12-31`);

        data.forEach(({ Name, Revenue, Date }) => {
            const orderDate = moment(Date, 'DD-MMM-YYYY');
            if (!orderDate.isBetween(startOfYear, endOfYear, null, '[]')) return;

            const weekNumber = orderDate.isoWeek();
            const weekKey = `Week ${weekNumber}`;

            if (!weeklyData.has(weekKey)) {
                weeklyData.set(weekKey, {
                    brands: new Map(),
                    startOfWeek: orderDate.clone().startOf('isoWeek'),
                    endOfWeek: orderDate.clone().endOf('isoWeek')
                });
            }

            const weekEntry = weeklyData.get(weekKey);
            const { brands } = weekEntry;

            if (!brands.has(Name)) {
                brands.set(Name, {
                    Week: [],   
                    Revenue: []   
                });
            }

            const revenue = parseInt(Revenue, 10) || 0;
            const brandData = brands.get(Name);
            const weekIndex = brandData.Week.indexOf(weekKey);
            
            if (weekIndex === -1) {
                brandData.Week.push(weekKey);
                brandData.Revenue.push(revenue);
            } else {
                brandData.Revenue[weekIndex] += revenue;
            }
        });

        const BrandWeeklyData = {};

        weeklyData.forEach((weekData) => {
            weekData.brands.forEach((brandData, brandName) => {
                if (!BrandWeeklyData[brandName]) {
                    BrandWeeklyData[brandName] = {
                        Week: [],
                        Revenue: []
                    };
                }

                brandData.Week.forEach((week, index) => {
                    const weekIndex = BrandWeeklyData[brandName].Week.indexOf(week);
                    if (weekIndex === -1) {
                        BrandWeeklyData[brandName].Week.push(week);
                        BrandWeeklyData[brandName].Revenue.push(brandData.Revenue[index]);
                    } else {
                        BrandWeeklyData[brandName].Revenue[weekIndex] += brandData.Revenue[index];
                    }
                });
            });
        });

        return {
            BrandWeeklyData
            // sortedUniqueWeeks: Array.from(weeklyData.keys())
        };
    }

    // function buildWeeklyCohortsWithBrandWeeks(data, names) {
    //     const dataByYear = {};

    //     data.forEach(({ Name, Quantity, Revenue, Date }) => {
    //         const orderDate = moment(Date, 'DD-MMM-YYYY');
    //         const year = orderDate.year();

    //         if (!dataByYear[year]) {
    //             dataByYear[year] = {};
    //         }

    //         if (!dataByYear[year][Name]) {
    //             dataByYear[year][Name] = {
    //                 Revenue: 0,
    //                 Quantity: 0
    //             };
    //         }

    //         const quantity = parseInt(Quantity, 10) || 0;
    //         const revenue = parseFloat(Revenue) || 0;

    //         dataByYear[year][Name].Quantity += quantity;
    //         dataByYear[year][Name].Revenue += revenue;
    //     });

    //     return {
    //         data: dataByYear
    //     };
    // }



    function monthlyChart(data)
    {
        const chartMonthlyData = new Map();
        const MonthlyTotalchartMonthlyQuantitys = new Map();

        data.forEach(({ Name, Date, Revenue, Quantity, Volume }) => {
            const orderDate = moment(Date, "DD-MMM-YYYY");
            const MonthKey = orderDate.format("YYYY-MM");
            const YearKey = orderDate.format("YYYY")
            // if (!BrandMonthlyData.has(Name)) {
            //     BrandMonthlyData.set(Name, new Map());
            // }
            // if (!BrandDailyData.has(Name))  {
            //     BrandDailyData.set(Name, new Map());
            // }    
            if(!chartMonthlyData.has(YearKey))
            {
                chartMonthlyData.set(YearKey, new Map());
            }
            const volume = parseFloat(Volume);
            const BrandData = chartMonthlyData.get(YearKey);        
            const totalRevenue = BrandData.get(YearKey) ? BrandData.get(YearKey).revenue : 0;
            const totalQuantity = BrandData.get(YearKey) ? BrandData.get(YearKey).quantity : 0;

            BrandData.set(MonthKey, {
                revenue: currentRevenue + parseFloat(Revenue),
                quantity: currentQuantity + parseInt(Quantity, 10),
                customers: new Set()
            });

            BrandData.get(MonthKey).customers.add(Name); 

            const monthlyTotal = MonthlyTotals.get(MonthKey) || { revenue: 0, quantity: 0, customers: new Set(), volumes: new Map()};
            
            monthlyTotal.customers.add(Name);

            MonthlyTotals.set(MonthKey, {
                revenue: monthlyTotal.revenue + parseFloat(Revenue),
                quantity: monthlyTotal.quantity + parseInt(Quantity, 10),
                customers: monthlyTotal.customers,
                volumes: monthlyTotal.volumes
            });

            if (volume) {
                const volumeMap = monthlyTotal.volumes;
                const currentVolumeQty = volumeMap.get(volume) || 0;
                volumeMap.set(volume, currentVolumeQty + parseInt(Quantity, 10));
            }
        });

        const sortedUniqueMonths = Array.from(MonthlyTotals.keys()).sort();
        return { BrandMonthlyData, sortedUniqueMonths, MonthlyTotals };
    }

    function buildDashboard(data)
    {
        let totalQuantity = 0;
        let totalRevenue = 0;
        let totalVolume = 0;
        data.forEach(({Name, Date, Revenue, Quantity, Volume})=>{
            
            totalQuantity += parseFloat(Quantity, 10) || 0;
            totalRevenue += parseFloat(Revenue, 10) || 0;
            totalVolume += parseFloat(Quantity*(Volume/1000));
    });
        return {totalQuantity, totalRevenue, totalVolume};
    }

    async function ClientNames(data, type) {
        const AllNames = Array.from(new Set(data.map(({ Name }) => Name).filter(Boolean)));

        const Customer_Data = await getCustomerData();
        
        if (!Customer_Data || Customer_Data.length === 0) {
            console.warn('No customer data found');
            return { AllNames, customerDictionary: {} };
        }

        const customerDictionary = {};
        const onboardedByMonth = {};
        const offboardedByMonth = {};
        let totalOnboardedTillDate = {};
        const monthlyActive = {};
        
        function calculateMonthsBetweenDates(startDate, endDate)
            {
                if(!startDate||!endDate) return 0;

                const start = new Date(startDate);
                const end = new Date(endDate);

                let months = (end.getFullYear() - start.getFullYear())*12;
                months -= start.getMonth();
                months += end.getMonth();

                return months <= 0? 1 : months + 1;
            }

            function calculateMonthsActive(startDate)
            {
                if(!startDate) return 0;

                const start = new Date(startDate);
                const currentDate = new Date();

                let months = (currentDate.getFullYear() - start.getFullYear())*12;

                months -= start.getMonth();
                months += currentDate.getMonth();

                return months <=0 ? 1 : months + 1;
            }

            
            function formatMonthYear(date) {
                const options = { year: 'numeric', month: 'short' };
                return new Date(date).toLocaleString('en-US', options);
            }

        Customer_Data.forEach(customer => {
            const brandName = customer.Brand_Name.display_value.trim();
            const brandStatus = customer.Customer_Status;
            const brandOnboard = customer.Onboarding_Date1 ? new Date(customer.Onboarding_Date1) : null;
            const brandOffboard = customer.Cancelled_Date ? new Date(customer.Cancelled_Date) : null;

            if (!customerDictionary[brandName]) {
                customerDictionary[brandName] = {
                    status: brandStatus,
                    earliestOnboardDate: brandOnboard,
                    latestOffboardDate: brandOffboard
                };
            }

            if (brandStatus === "Active") {
                customerDictionary[brandName].status = "Active",
                customerDictionary[brandName].latestOffboardDate = null;
            }

            if (brandOnboard && (!customerDictionary[brandName].earliestOnboardDate || brandOnboard < customerDictionary[brandName].earliestOnboardDate)) {
                customerDictionary[brandName].earliestOnboardDate = brandOnboard;
            }

            if (brandOffboard && (!customerDictionary[brandName].latestOffboardDate || brandOffboard > customerDictionary[brandName].latestOffboardDate)) {
                customerDictionary[brandName].latestOffboardDate = brandOffboard;
            }
        });

            

            const formattedCustomerData = {};
            
            // const totalOnboardedTillDate = {};

            Object.keys(customerDictionary).forEach(name => {
                const data = customerDictionary[name];
                const onboardDate = data.earliestOnboardDate ? data.earliestOnboardDate.toISOString().split('T')[0] : null;
                const offboardDate = data.latestOffboardDate ? data.latestOffboardDate.toISOString().split('T')[0] : null;

                const monthsActive = offboardDate?calculateMonthsBetweenDates(onboardDate, offboardDate) :calculateMonthsActive(onboardDate);

                formattedCustomerData[name] = {
                    CustomerStatus: data.status,
                    OnboardDate: onboardDate,
                    OffboardDate: offboardDate,
                    MonthsActive: monthsActive
                }; 

                if(onboardDate)
                {
                    const onboardMonth = formatMonthYear(onboardDate);
                    onboardedByMonth[onboardMonth] = onboardedByMonth[onboardMonth] || 0;
                    onboardedByMonth[onboardMonth]++;
                }

                if (offboardDate) {
                    const offboardMonth = formatMonthYear(offboardDate);
                    offboardedByMonth[offboardMonth] = offboardedByMonth[offboardMonth] || 0;
                    offboardedByMonth[offboardMonth]++;
                }

                
                if(type==0)
                {
                    let cumulativeOnboarded = 0;
                    Object.keys(onboardedByMonth).sort((a, b) => {
                    const dateA = new Date(a);
                    const dateB = new Date(b);
                    return dateA - dateB;
                }).forEach(month => {
                    cumulativeOnboarded += onboardedByMonth[month];
                    totalOnboardedTillDate[month] = cumulativeOnboarded;
                }); 
                }             
            });

        
        return { AllNames, customerDictionary: formattedCustomerData, onboardedByMonth, offboardedByMonth,totalOnboardedTillDate};
    }

    let refreshToken = '1000.40edd439cbb238d1d05c045eaf193349.f28ffe2cb5d851b2636a80ed6e0b855b';

    function loadAccessToken() {
        try {
            const data = fs.readFileSync(tokenFilePath, 'utf-8');
            return JSON.parse(data).access_token;
        } catch (error) {
            console.log('No saved access token found or file does not exist.');
            return null;
        }
    }

    function saveAccessToken(token) {
        try {
            fs.writeFileSync(tokenFilePath, JSON.stringify({ access_token: token }), 'utf-8');
            logger.info('Access token saved to file.');
        } catch (error) {
            logger.error('Error saving access token:', error);
        }
    }

    async function refreshAccessToken() {
        try {
            const response = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
                params: {
                    refresh_token: refreshToken,
                    client_id: process.env.CLIENT_ID,
                    client_secret: process.env.CLIENT_SECRET,
                    grant_type: 'refresh_token'
                }
            });
            const newAccessToken = response.data.access_token;
            saveAccessToken(newAccessToken);
            return newAccessToken;
        } catch (error) {
            // console.error('Error refreshing access token:', error.response?.data || error.message);
            // return false;
            logger.error('Error refreshing access token:', error.response?.data || error.message);
            throw new Error('Failed to refresh access token');
        }
    }

    async function getCustomerData() {
        let accessToken = loadAccessToken();
        if (!accessToken) {
            // console.log('Access token not found, refreshing...');
            logger.info('Access token not found, refreshing...');
            accessToken = await refreshAccessToken();
        }

        const url = 'https://creator.zoho.in/api/v2/uravu_labs_pvt_ltd/uravu-bottling/report/Compact_Customer_List';
        const headers = {
            'Authorization': `Zoho-oauthtoken ${accessToken}`,
            'Content-Type': 'application/json'
        };

        try {
            const response = await axios.get(url, { headers });
            return response.data.data || [];
        } catch (error) {
            if (error.response?.status === 401) {
                console.warn('Access token expired, refreshing token...');
                const refreshed = await refreshAccessToken();
                if (refreshed) {
                    headers.Authorization = `Zoho-oauthtoken ${accessToken}`;
                    try {
                        const retryResponse = await axios.get(url, { headers });
                        return retryResponse.data.data || [];
                    } catch (retryError) {
                        console.error('Error fetching data on retry:', retryError.response?.data || retryError.message);
                    }
                }
            }
            console.error('Error fetching data:', error.response?.data || error.message);
            return []; 
        }
    }

    async function fetchData() {
        if (cachedData && (Date.now() - cacheTime < CACHE_EXPIRATION)) {
            return cachedData;
        }

        // const apiUrl = `https://www.zohoapis.in/creator/custom/uravu_labs_pvt_ltd/Fetch_Bottle_Data?publickey=${process.env.ZOHO_API_KEY}`;
        // const response = await axios.get(apiUrl);
        
        // console.log("API Response:", response.data);
        // const rawData = response.data.result;

    const result = `[{
    "Name": "Alpha Brews",
    "Date": "02-Jun-2024",
    "Volume": 750,
    "Revenue": "24554.10",
    "Quantity": "499"
  },
  {
    "Name": "Beta Beverages",
    "Date": "03-Jun-2024",
    "Volume": 500,
    "Revenue": "43146.96",
    "Quantity": "887"
  },
  {
    "Name": "Gamma Drinks",
    "Date": "04-Jun-2024",
    "Volume": 750,
    "Revenue": "47346.60",
    "Quantity": "1088"
  },
  {
    "Name": "Delta Distributors",
    "Date": "05-Jun-2024",
    "Volume": 500,
    "Revenue": "55887.85",
    "Quantity": "1186"
  },
  {
    "Name": "Epsilon Supplies",
    "Date": "06-Jun-2024",
    "Volume": 750,
    "Revenue": "51710.21",
    "Quantity": "1255"
  },
  {
    "Name": "Zeta Logistics",
    "Date": "07-Jun-2024",
    "Volume": 500,
    "Revenue": "80742.03",
    "Quantity": "1741"
  },
  {
    "Name": "Eta Services",
    "Date": "08-Jun-2024",
    "Volume": 750,
    "Revenue": "83381.26",
    "Quantity": "1710"
  },
  {
    "Name": "Theta Retail",
    "Date": "09-Jun-2024",
    "Volume": 500,
    "Revenue": "53595.90",
    "Quantity": "1146"
  },
  {
    "Name": "Iota Traders",
    "Date": "10-Jun-2024",
    "Volume": 750,
    "Revenue": "72539.76",
    "Quantity": "1664"
  },
  {
    "Name": "Kappa Wholesalers",
    "Date": "11-Jun-2024",
    "Volume": 500,
    "Revenue": "35361.28",
    "Quantity": "721"
  },
  {
    "Name": "Lambda Vendors",
    "Date": "12-Jun-2024",
    "Volume": 750,
    "Revenue": "37892.54",
    "Quantity": "920"
  },
  {
    "Name": "Mu Suppliers",
    "Date": "13-Jun-2024",
    "Volume": 500,
    "Revenue": "18457.46",
    "Quantity": "371"
  },
  {
    "Name": "Nu Goods",
    "Date": "14-Jun-2024",
    "Volume": 750,
    "Revenue": "29037.65",
    "Quantity": "691"
  },
  {
    "Name": "Xi Merchants",
    "Date": "15-Jun-2024",
    "Volume": 500,
    "Revenue": "41206.31",
    "Quantity": "1017"
  },
  {
    "Name": "Omicron Providers",
    "Date": "16-Jun-2024",
    "Volume": 750,
    "Revenue": "43057.98",
    "Quantity": "939"
  },
  {
    "Name": "Pi Distributors",
    "Date": "17-Jun-2024",
    "Volume": 500,
    "Revenue": "32051.53",
    "Quantity": "725"
  },
  {
    "Name": "Rho Beverages",
    "Date": "18-Jun-2024",
    "Volume": 750,
    "Revenue": "71722.72",
    "Quantity": "1630"
  },
  {
    "Name": "Sigma Drinks",
    "Date": "19-Jun-2024",
    "Volume": 500,
    "Revenue": "44224.40",
    "Quantity": "1024"
  },
  {
    "Name": "Tau Services",
    "Date": "20-Jun-2024",
    "Volume": 750,
    "Revenue": "56504.10",
    "Quantity": "1154"
  },
  {
    "Name": "Upsilon Logistics",
    "Date": "21-Jun-2024",
    "Volume": 500,
    "Revenue": "19711.04",
    "Quantity": "457"
  },
  {
    "Name": "Phi Retail",
    "Date": "22-Jun-2024",
    "Volume": 750,
    "Revenue": "23004.15",
    "Quantity": "512"
  },
  {
    "Name": "Chi Wholesalers",
    "Date": "23-Jun-2024",
    "Volume": 500,
    "Revenue": "52406.21",
    "Quantity": "1060"
  },
  {
    "Name": "Psi Vendors",
    "Date": "24-Jun-2024",
    "Volume": 750,
    "Revenue": "82893.32",
    "Quantity": "1672"
  },
  {
    "Name": "Omega Supplies",
    "Date": "25-Jun-2024",
    "Volume": 500,
    "Revenue": "49775.64",
    "Quantity": "1006"
  },
  {
    "Name": "Alpha Brews",
    "Date": "26-Jun-2024",
    "Volume": 750,
    "Revenue": "14709.72",
    "Quantity": "357"
  },
  {
    "Name": "Beta Beverages",
    "Date": "27-Jun-2024",
    "Volume": 500,
    "Revenue": "64192.48",
    "Quantity": "1319"
  },
  {
    "Name": "Gamma Drinks",
    "Date": "28-Jun-2024",
    "Volume": 750,
    "Revenue": "36107.60",
    "Quantity": "756"
  },
  {
    "Name": "Delta Distributors",
    "Date": "29-Jun-2024",
    "Volume": 500,
    "Revenue": "42100.39",
    "Quantity": "905"
  },
  {
    "Name": "Epsilon Supplies",
    "Date": "30-Jun-2024",
    "Volume": 750,
    "Revenue": "82421.39",
    "Quantity": "1670"
  },
  {
    "Name": "Zeta Logistics",
    "Date": "01-Jul-2024",
    "Volume": 500,
    "Revenue": "23078.12",
    "Quantity": "574"
  },
  {
    "Name": "Eta Services",
    "Date": "02-Jul-2024",
    "Volume": 750,
    "Revenue": "21092.97",
    "Quantity": "437"
  },
  {
    "Name": "Theta Retail",
    "Date": "03-Jul-2024",
    "Volume": 500,
    "Revenue": "24449.95",
    "Quantity": "532"
  },
  {
    "Name": "Iota Traders",
    "Date": "04-Jul-2024",
    "Volume": 750,
    "Revenue": "18941.60",
    "Quantity": "473"
  },
  {
    "Name": "Kappa Wholesalers",
    "Date": "05-Jul-2024",
    "Volume": 500,
    "Revenue": "62247.24",
    "Quantity": "1380"
  },
  {
    "Name": "Lambda Vendors",
    "Date": "06-Jul-2024",
    "Volume": 750,
    "Revenue": "31430.65",
    "Quantity": "679"
  },
  {
    "Name": "Mu Suppliers",
    "Date": "07-Jul-2024",
    "Volume": 500,
    "Revenue": "12512.42",
    "Quantity": "301"
  },
  {
    "Name": "Nu Goods",
    "Date": "08-Jul-2024",
    "Volume": 750,
    "Revenue": "50207.94",
    "Quantity": "1175"
  },
  {
    "Name": "Xi Merchants",
    "Date": "09-Jul-2024",
    "Volume": 500,
    "Revenue": "71324.03",
    "Quantity": "1441"
  },
  {
    "Name": "Omicron Providers",
    "Date": "10-Jul-2024",
    "Volume": 750,
    "Revenue": "43944.84",
    "Quantity": "990"
  },
  {
    "Name": "Pi Distributors",
    "Date": "11-Jul-2024",
    "Volume": 500,
    "Revenue": "80276.88",
    "Quantity": "1769"
  },
  {
    "Name": "Rho Beverages",
    "Date": "12-Jul-2024",
    "Volume": 750,
    "Revenue": "59874.79",
    "Quantity": "1446"
  },
  {
    "Name": "Sigma Drinks",
    "Date": "13-Jul-2024",
    "Volume": 500,
    "Revenue": "71132.99",
    "Quantity": "1609"
  },
  {
    "Name": "Tau Services",
    "Date": "14-Jul-2024",
    "Volume": 750,
    "Revenue": "84315.23",
    "Quantity": "1742"
  },
  {
    "Name": "Upsilon Logistics",
    "Date": "15-Jul-2024",
    "Volume": 500,
    "Revenue": "22262.01",
    "Quantity": "510"
  },
  {
    "Name": "Phi Retail",
    "Date": "16-Jul-2024",
    "Volume": 750,
    "Revenue": "15587.30",
    "Quantity": "350"
  },
  {
    "Name": "Chi Wholesalers",
    "Date": "17-Jul-2024",
    "Volume": 500,
    "Revenue": "62982.69",
    "Quantity": "1374"
  },
  {
    "Name": "Psi Vendors",
    "Date": "18-Jul-2024",
    "Volume": 750,
    "Revenue": "48500.00",
    "Quantity": "971"
  },
  {
    "Name": "Omega Supplies",
    "Date": "19-Jul-2024",
    "Volume": 500,
    "Revenue": "24007.19",
    "Quantity": "561"
  },
  {
    "Name": "Alpha Brews",
    "Date": "20-Jul-2024",
    "Volume": 750,
    "Revenue": "49697.31",
    "Quantity": "995"
  },
  {
    "Name": "Beta Beverages",
    "Date": "21-Jul-2024",
    "Volume": 500,
    "Revenue": "69912.99",
    "Quantity": "1575"
  },
  {
    "Name": "Gamma Drinks",
    "Date": "22-Jul-2024",
    "Volume": 750,
    "Revenue": "66287.72",
    "Quantity": "1505"
  },
  {
    "Name": "Delta Distributors",
    "Date": "23-Jul-2024",
    "Volume": 500,
    "Revenue": "16137.26",
    "Quantity": "327"
  },
  {
    "Name": "Epsilon Supplies",
    "Date": "24-Jul-2024",
    "Volume": 750,
    "Revenue": "46278.19",
    "Quantity": "1092"
  },
  {
    "Name": "Zeta Logistics",
    "Date": "25-Jul-2024",
    "Volume": 500,
    "Revenue": "34502.06",
    "Quantity": "822"
  },
  {
    "Name": "Eta Services",
    "Date": "26-Jul-2024",
    "Volume": 750,
    "Revenue": "43763.21",
    "Quantity": "968"
  },
  {
    "Name": "Theta Retail",
    "Date": "27-Jul-2024",
    "Volume": 500,
    "Revenue": "16944.99",
    "Quantity": "369"
  },
  {
    "Name": "Iota Traders",
    "Date": "28-Jul-2024",
    "Volume": 750,
    "Revenue": "66847.83",
    "Quantity": "1407"
  },
  {
    "Name": "Kappa Wholesalers",
    "Date": "29-Jul-2024",
    "Volume": 500,
    "Revenue": "19186.19",
    "Quantity": "404"
  },
  {
    "Name": "Lambda Vendors",
    "Date": "30-Jul-2024",
    "Volume": 750,
    "Revenue": "32523.15",
    "Quantity": "802"
  },
  {
    "Name": "Mu Suppliers",
    "Date": "31-Jul-2024",
    "Volume": 500,
    "Revenue": "44955.94",
    "Quantity": "919"
  },
  {
    "Name": "Nu Goods",
    "Date": "01-Aug-2024",
    "Volume": 750,
    "Revenue": "67957.74",
    "Quantity": "1632"
  },
  {
    "Name": "Xi Merchants",
    "Date": "02-Aug-2024",
    "Volume": 500,
    "Revenue": "54362.11",
    "Quantity": "1306"
  },
  {
    "Name": "Omicron Providers",
    "Date": "03-Aug-2024",
    "Volume": 750,
    "Revenue": "16385.38",
    "Quantity": "404"
  },
  {
    "Name": "Pi Distributors",
    "Date": "04-Aug-2024",
    "Volume": 500,
    "Revenue": "33242.99",
    "Quantity": "816"
  },
  {
    "Name": "Rho Beverages",
    "Date": "05-Aug-2024",
    "Volume": 750,
    "Revenue": "73993.45",
    "Quantity": "1499"
  },
  {
    "Name": "Sigma Drinks",
    "Date": "06-Aug-2024",
    "Volume": 500,
    "Revenue": "54864.46",
    "Quantity": "1286"
  },
  {
    "Name": "Tau Services",
    "Date": "07-Aug-2024",
    "Volume": 750,
    "Revenue": "40246.74",
    "Quantity": "953"
  },
  {
    "Name": "Upsilon Logistics",
    "Date": "08-Aug-2024",
    "Volume": 500,
    "Revenue": "74611.46",
    "Quantity": "1588"
  },
  {
    "Name": "Phi Retail",
    "Date": "09-Aug-2024",
    "Volume": 750,
    "Revenue": "69822.67",
    "Quantity": "1715"
  },
  {
    "Name": "Chi Wholesalers",
    "Date": "10-Aug-2024",
    "Volume": 500,
    "Revenue": "58248.44",
    "Quantity": "1281"
  },
  {
    "Name": "Psi Vendors",
    "Date": "11-Aug-2024",
    "Volume": 750,
    "Revenue": "43513.74",
    "Quantity": "980"
  },
  {
    "Name": "Omega Supplies",
    "Date": "12-Aug-2024",
    "Volume": 500,
    "Revenue": "18263.26",
    "Quantity": "370"
  },
  {
    "Name": "Alpha Brews",
    "Date": "13-Aug-2024",
    "Volume": 750,
    "Revenue": "67221.43",
    "Quantity": "1537"
  },
  {
    "Name": "Beta Beverages",
    "Date": "14-Aug-2024",
    "Volume": 500,
    "Revenue": "77866.80",
    "Quantity": "1646"
  },
  {
    "Name": "Gamma Drinks",
    "Date": "15-Aug-2024",
    "Volume": 750,
    "Revenue": "54808.60",
    "Quantity": "1169"
  },
  {
    "Name": "Delta Distributors",
    "Date": "16-Aug-2024",
    "Volume": 500,
    "Revenue": "63919.78",
    "Quantity": "1496"
  },
  {
    "Name": "Epsilon Supplies",
    "Date": "17-Aug-2024",
    "Volume": 750,
    "Revenue": "46322.84",
    "Quantity": "1061"
  },
  {
    "Name": "Zeta Logistics",
    "Date": "18-Aug-2024",
    "Volume": 500,
    "Revenue": "36158.48",
    "Quantity": "903"
  },
  {
    "Name": "Eta Services",
    "Date": "19-Aug-2024",
    "Volume": 750,
    "Revenue": "44435.21",
    "Quantity": "1000"
  },
  {
    "Name": "Theta Retail",
    "Date": "20-Aug-2024",
    "Volume": 500,
    "Revenue": "60900.80",
    "Quantity": "1246"
  },
  {
    "Name": "Iota Traders",
    "Date": "21-Aug-2024",
    "Volume": 750,
    "Revenue": "41290.96",
    "Quantity": "999"
  },
  {
    "Name": "Kappa Wholesalers",
    "Date": "22-Aug-2024",
    "Volume": 500,
    "Revenue": "31629.95",
    "Quantity": "722"
  },
  {
    "Name": "Lambda Vendors",
    "Date": "23-Aug-2024",
    "Volume": 750,
    "Revenue": "28147.56",
    "Quantity": "699"
  },
  {
    "Name": "Mu Suppliers",
    "Date": "24-Aug-2024",
    "Volume": 500,
    "Revenue": "18711.71",
    "Quantity": "375"
  },
  {
    "Name": "Nu Goods",
    "Date": "25-Aug-2024",
    "Volume": 750,
    "Revenue": "62774.19",
    "Quantity": "1524"
  },
  {
    "Name": "Xi Merchants",
    "Date": "26-Aug-2024",
    "Volume": 500,
    "Revenue": "71684.58",
    "Quantity": "1681"
  },
  {
    "Name": "Omicron Providers",
    "Date": "27-Aug-2024",
    "Volume": 750,
    "Revenue": "67780.58",
    "Quantity": "1627"
  },
  {
    "Name": "Pi Distributors",
    "Date": "28-Aug-2024",
    "Volume": 500,
    "Revenue": "67034.75",
    "Quantity": "1509"
  },
  {
    "Name": "Rho Beverages",
    "Date": "29-Aug-2024",
    "Volume": 750,
    "Revenue": "71353.17",
    "Quantity": "1504"
  },
  {
    "Name": "Sigma Drinks",
    "Date": "30-Aug-2024",
    "Volume": 500,
    "Revenue": "22548.44",
    "Quantity": "533"
  },
  {
    "Name": "Tau Services",
    "Date": "31-Aug-2024",
    "Volume": 750,
    "Revenue": "44651.09",
    "Quantity": "896"
  },
  {
    "Name": "Upsilon Logistics",
    "Date": "01-Sep-2024",
    "Volume": 500,
    "Revenue": "33165.67",
    "Quantity": "765"
  },
  {
    "Name": "Phi Retail",
    "Date": "02-Sep-2024",
    "Volume": 750,
    "Revenue": "80027.85",
    "Quantity": "1795"
  },
  {
    "Name": "Chi Wholesalers",
    "Date": "03-Sep-2024",
    "Volume": 500,
    "Revenue": "22296.34",
    "Quantity": "512"
  },
  {
    "Name": "Psi Vendors",
    "Date": "04-Sep-2024",
    "Volume": 750,
    "Revenue": "60545.30",
    "Quantity": "1270"
  },
  {
    "Name": "Omega Supplies",
    "Date": "05-Sep-2024",
    "Volume": 500,
    "Revenue": "23888.15",
    "Quantity": "481"
  },
  {
    "Name": "Alpha Brews",
    "Date": "06-Sep-2024",
    "Volume": 750,
    "Revenue": "23048.60",
    "Quantity": "546"
  },
  {
    "Name": "Beta Beverages",
    "Date": "07-Sep-2024",
    "Volume": 500,
    "Revenue": "59153.17",
    "Quantity": "1333"
  },
  {
    "Name": "Gamma Drinks",
    "Date": "08-Sep-2024",
    "Volume": 750,
    "Revenue": "13725.88",
    "Quantity": "325"
  },
  {
    "Name": "Delta Distributors",
    "Date": "09-Sep-2024",
    "Volume": 500,
    "Revenue": "73506.40",
    "Quantity": "1676"
  },
  {
    "Name": "Epsilon Supplies",
    "Date": "10-Sep-2024",
    "Volume": 750,
    "Revenue": "78325.55",
    "Quantity": "1680"
  },
  {
    "Name": "Zeta Logistics",
    "Date": "11-Sep-2024",
    "Volume": 500,
    "Revenue": "25921.09",
    "Quantity": "627"
  },
  {
    "Name": "Eta Services",
    "Date": "12-Sep-2024",
    "Volume": 750,
    "Revenue": "22511.59",
    "Quantity": "468"
  },
  {
    "Name": "Theta Retail",
    "Date": "13-Sep-2024",
    "Volume": 500,
    "Revenue": "85563.81",
    "Quantity": "1753"
  },
  {
    "Name": "Iota Traders",
    "Date": "14-Sep-2024",
    "Volume": 750,
    "Revenue": "37514.55",
    "Quantity": "928"
  },
  {
    "Name": "Kappa Wholesalers",
    "Date": "15-Sep-2024",
    "Volume": 500,
    "Revenue": "50182.74",
    "Quantity": "1224"
  },
  {
    "Name": "Lambda Vendors",
    "Date": "16-Sep-2024",
    "Volume": 750,
    "Revenue": "13435.46",
    "Quantity": "309"
  },
  {
    "Name": "Mu Suppliers",
    "Date": "17-Sep-2024",
    "Volume": 500,
    "Revenue": "21935.86",
    "Quantity": "469"
  },
  {
    "Name": "Nu Goods",
    "Date": "18-Sep-2024",
    "Volume": 750,
    "Revenue": "66838.58",
    "Quantity": "1541"
  },
  {
    "Name": "Xi Merchants",
    "Date": "19-Sep-2024",
    "Volume": 500,
    "Revenue": "64627.30",
    "Quantity": "1399"
  },
  {
    "Name": "Omicron Providers",
    "Date": "20-Sep-2024",
    "Volume": 750,
    "Revenue": "30629.62",
    "Quantity": "632"
  },
  {
    "Name": "Pi Distributors",
    "Date": "21-Sep-2024",
    "Volume": 500,
    "Revenue": "50197.71",
    "Quantity": "1121"
  },
  {
    "Name": "Rho Beverages",
    "Date": "22-Sep-2024",
    "Volume": 750,
    "Revenue": "30474.57",
    "Quantity": "754"
  },
  {
    "Name": "Sigma Drinks",
    "Date": "23-Sep-2024",
    "Volume": 500,
    "Revenue": "16507.56",
    "Quantity": "400"
  },
  {
    "Name": "Tau Services",
    "Date": "24-Sep-2024",
    "Volume": 750,
    "Revenue": "40765.55",
    "Quantity": "979"
  },
  {
    "Name": "Upsilon Logistics",
    "Date": "25-Sep-2024",
    "Volume": 500,
    "Revenue": "63635.23",
    "Quantity": "1393"
  },
  {
    "Name": "Phi Retail",
    "Date": "26-Sep-2024",
    "Volume": 750,
    "Revenue": "58111.90",
    "Quantity": "1342"
  },
  {
    "Name": "Chi Wholesalers",
    "Date": "27-Sep-2024",
    "Volume": 500,
    "Revenue": "13373.44",
    "Quantity": "317"
  },
  {
    "Name": "Psi Vendors",
    "Date": "28-Sep-2024",
    "Volume": 750,
    "Revenue": "70125.17",
    "Quantity": "1475"
  },
  {
    "Name": "Omega Supplies",
    "Date": "29-Sep-2024",
    "Volume": 500,
    "Revenue": "63660.65",
    "Quantity": "1553"
  },
  {
    "Name": "Alpha Brews",
    "Date": "30-Sep-2024",
    "Volume": 750,
    "Revenue": "52546.75",
    "Quantity": "1207"
  },
  {
    "Name": "Beta Beverages",
    "Date": "01-Oct-2024",
    "Volume": 500,
    "Revenue": "75288.99",
    "Quantity": "1730"
  },
  {
    "Name": "Gamma Drinks",
    "Date": "02-Oct-2024",
    "Volume": 750,
    "Revenue": "28853.76",
    "Quantity": "635"
  },
  {
    "Name": "Delta Distributors",
    "Date": "03-Oct-2024",
    "Volume": 500,
    "Revenue": "64281.41",
    "Quantity": "1563"
  },
  {
    "Name": "Epsilon Supplies",
    "Date": "04-Oct-2024",
    "Volume": 750,
    "Revenue": "65229.69",
    "Quantity": "1361"
  },
  {
    "Name": "Zeta Logistics",
    "Date": "05-Oct-2024",
    "Volume": 500,
    "Revenue": "69214.20",
    "Quantity": "1433"
  },
  {
    "Name": "Eta Services",
    "Date": "06-Oct-2024",
    "Volume": 750,
    "Revenue": "47497.46",
    "Quantity": "1046"
  },
  {
    "Name": "Theta Retail",
    "Date": "07-Oct-2024",
    "Volume": 500,
    "Revenue": "76721.77",
    "Quantity": "1775"
  },
  {
    "Name": "Iota Traders",
    "Date": "08-Oct-2024",
    "Volume": 750,
    "Revenue": "38211.18",
    "Quantity": "899"
  },
  {
    "Name": "Kappa Wholesalers",
    "Date": "09-Oct-2024",
    "Volume": 500,
    "Revenue": "31640.54",
    "Quantity": "761"
  },
  {
    "Name": "Lambda Vendors",
    "Date": "10-Oct-2024",
    "Volume": 750,
    "Revenue": "61169.72",
    "Quantity": "1281"
  },
  {
    "Name": "Mu Suppliers",
    "Date": "11-Oct-2024",
    "Volume": 500,
    "Revenue": "58909.58",
    "Quantity": "1359"
  },
  {
    "Name": "Nu Goods",
    "Date": "12-Oct-2024",
    "Volume": 750,
    "Revenue": "56952.70",
    "Quantity": "1206"
  },
  {
    "Name": "Xi Merchants",
    "Date": "13-Oct-2024",
    "Volume": 500,
    "Revenue": "32045.00",
    "Quantity": "695"
  },
  {
    "Name": "Omicron Providers",
    "Date": "14-Oct-2024",
    "Volume": 750,
    "Revenue": "28171.66",
    "Quantity": "650"
  },
  {
    "Name": "Pi Distributors",
    "Date": "15-Oct-2024",
    "Volume": 500,
    "Revenue": "42055.73",
    "Quantity": "1001"
  },
  {
    "Name": "Rho Beverages",
    "Date": "16-Oct-2024",
    "Volume": 750,
    "Revenue": "73940.98",
    "Quantity": "1549"
  },
  {
    "Name": "Sigma Drinks",
    "Date": "17-Oct-2024",
    "Volume": 500,
    "Revenue": "52636.51",
    "Quantity": "1229"
  },
  {
    "Name": "Tau Services",
    "Date": "18-Oct-2024",
    "Volume": 750,
    "Revenue": "63969.36",
    "Quantity": "1485"
  },
  {
    "Name": "Upsilon Logistics",
    "Date": "19-Oct-2024",
    "Volume": 500,
    "Revenue": "20646.41",
    "Quantity": "414"
  },
  {
    "Name": "Phi Retail",
    "Date": "20-Oct-2024",
    "Volume": 750,
    "Revenue": "44575.38",
    "Quantity": "1029"
  },
  {
    "Name": "Chi Wholesalers",
    "Date": "21-Oct-2024",
    "Volume": 500,
    "Revenue": "26859.09",
    "Quantity": "620"
  },
  {
    "Name": "Psi Vendors",
    "Date": "22-Oct-2024",
    "Volume": 750,
    "Revenue": "46453.78",
    "Quantity": "1080"
  },
  {
    "Name": "Omega Supplies",
    "Date": "23-Oct-2024",
    "Volume": 500,
    "Revenue": "21851.38",
    "Quantity": "462"
  },
  {
    "Name": "Alpha Brews",
    "Date": "24-Oct-2024",
    "Volume": 750,
    "Revenue": "52625.20",
    "Quantity": "1292"
  },
  {
    "Name": "Beta Beverages",
    "Date": "25-Oct-2024",
    "Volume": 500,
    "Revenue": "56781.00",
    "Quantity": "1344"
  },
  {
    "Name": "Gamma Drinks",
    "Date": "26-Oct-2024",
    "Volume": 750,
    "Revenue": "47836.19",
    "Quantity": "980"
  },
  {
    "Name": "Delta Distributors",
    "Date": "27-Oct-2024",
    "Volume": 500,
    "Revenue": "50312.71",
    "Quantity": "1013"
  },
  {
    "Name": "Epsilon Supplies",
    "Date": "28-Oct-2024",
    "Volume": 750,
    "Revenue": "16405.93",
    "Quantity": "377"
  },
  {
    "Name": "Zeta Logistics",
    "Date": "29-Oct-2024",
    "Volume": 500,
    "Revenue": "26115.00",
    "Quantity": "568"
  },
  {
    "Name": "Eta Services",
    "Date": "30-Oct-2024",
    "Volume": 750,
    "Revenue": "24111.49",
    "Quantity": "559"
  },
  {
    "Name": "Theta Retail",
    "Date": "31-Oct-2024",
    "Volume": 500,
    "Revenue": "51910.63",
    "Quantity": "1045"
  },
  {
    "Name": "Iota Traders",
    "Date": "01-Nov-2024",
    "Volume": 750,
    "Revenue": "26540.30",
    "Quantity": "620"
  },
  {
    "Name": "Kappa Wholesalers",
    "Date": "02-Nov-2024",
    "Volume": 500,
    "Revenue": "38478.06",
    "Quantity": "781"
  },
  {
    "Name": "Lambda Vendors",
    "Date": "03-Nov-2024",
    "Volume": 750,
    "Revenue": "79941.45",
    "Quantity": "1688"
  },
  {
    "Name": "Mu Suppliers",
    "Date": "04-Nov-2024",
    "Volume": 500,
    "Revenue": "78995.83",
    "Quantity": "1800"
  },
  {
    "Name": "Nu Goods",
    "Date": "05-Nov-2024",
    "Volume": 750,
    "Revenue": "25169.57",
    "Quantity": "528"
  },
  {
    "Name": "Xi Merchants",
    "Date": "06-Nov-2024",
    "Volume": 500,
    "Revenue": "57076.22",
    "Quantity": "1326"
  },
  {
    "Name": "Omicron Providers",
    "Date": "07-Nov-2024",
    "Volume": 750,
    "Revenue": "60648.46",
    "Quantity": "1276"
  },
  {
    "Name": "Pi Distributors",
    "Date": "08-Nov-2024",
    "Volume": 500,
    "Revenue": "54414.26",
    "Quantity": "1197"
  },
  {
    "Name": "Rho Beverages",
    "Date": "09-Nov-2024",
    "Volume": 750,
    "Revenue": "64801.80",
    "Quantity": "1479"
  },
  {
    "Name": "Sigma Drinks",
    "Date": "10-Nov-2024",
    "Volume": 500,
    "Revenue": "36036.84",
    "Quantity": "845"
  },
  {
    "Name": "Tau Services",
    "Date": "11-Nov-2024",
    "Volume": 750,
    "Revenue": "49384.01",
    "Quantity": "1233"
  },
  {
    "Name": "Upsilon Logistics",
    "Date": "12-Nov-2024",
    "Volume": 500,
    "Revenue": "13773.07",
    "Quantity": "302"
  },
  {
    "Name": "Phi Retail",
    "Date": "13-Nov-2024",
    "Volume": 750,
    "Revenue": "20272.70",
    "Quantity": "445"
  },
  {
    "Name": "Chi Wholesalers",
    "Date": "14-Nov-2024",
    "Volume": 500,
    "Revenue": "69726.06",
    "Quantity": "1513"
  },
  {
    "Name": "Psi Vendors",
    "Date": "15-Nov-2024",
    "Volume": 750,
    "Revenue": "75267.95",
    "Quantity": "1667"
  },
  {
    "Name": "Omega Supplies",
    "Date": "16-Nov-2024",
    "Volume": 500,
    "Revenue": "80914.32",
    "Quantity": "1730"
  },
  {
    "Name": "Alpha Brews",
    "Date": "17-Nov-2024",
    "Volume": 750,
    "Revenue": "35761.23",
    "Quantity": "725"
  },
  {
    "Name": "Beta Beverages",
    "Date": "18-Nov-2024",
    "Volume": 500,
    "Revenue": "71306.80",
    "Quantity": "1550"
  },
  {
    "Name": "Gamma Drinks",
    "Date": "19-Nov-2024",
    "Volume": 750,
    "Revenue": "69024.78",
    "Quantity": "1469"
  },
  {
    "Name": "Delta Distributors",
    "Date": "20-Nov-2024",
    "Volume": 500,
    "Revenue": "14141.27",
    "Quantity": "315"
  },
  {
    "Name": "Epsilon Supplies",
    "Date": "21-Nov-2024",
    "Volume": 750,
    "Revenue": "49544.52",
    "Quantity": "1115"
  },
  {
    "Name": "Zeta Logistics",
    "Date": "22-Nov-2024",
    "Volume": 500,
    "Revenue": "15719.04",
    "Quantity": "368"
  },
  {
    "Name": "Eta Services",
    "Date": "23-Nov-2024",
    "Volume": 750,
    "Revenue": "21752.96",
    "Quantity": "485"
  },
  {
    "Name": "Theta Retail",
    "Date": "24-Nov-2024",
    "Volume": 500,
    "Revenue": "48023.59",
    "Quantity": "1160"
  },
  {
    "Name": "Iota Traders",
    "Date": "25-Nov-2024",
    "Volume": 750,
    "Revenue": "26151.66",
    "Quantity": "546"
  },
  {
    "Name": "Kappa Wholesalers",
    "Date": "26-Nov-2024",
    "Volume": 500,
    "Revenue": "64677.07",
    "Quantity": "1437"
  },
  {
    "Name": "Lambda Vendors",
    "Date": "27-Nov-2024",
    "Volume": 750,
    "Revenue": "45415.38",
    "Quantity": "1000"
  },
  {
    "Name": "Mu Suppliers",
    "Date": "28-Nov-2024",
    "Volume": 500,
    "Revenue": "14161.97",
    "Quantity": "315"
  },
  {
    "Name": "Nu Goods",
    "Date": "29-Nov-2024",
    "Volume": 750,
    "Revenue": "68559.71",
    "Quantity": "1476"
  },
  {
    "Name": "Xi Merchants",
    "Date": "30-Nov-2024",
    "Volume": 500,
    "Revenue": "47425.61",
    "Quantity": "1115"
  },
  {
    "Name": "Omicron Providers",
    "Date": "01-Dec-2024",
    "Volume": 750,
    "Revenue": "55819.84",
    "Quantity": "1395"
  },
  {
    "Name": "Pi Distributors",
    "Date": "02-Dec-2024",
    "Volume": 500,
    "Revenue": "79849.36",
    "Quantity": "1648"
  },
  {
    "Name": "Rho Beverages",
    "Date": "03-Dec-2024",
    "Volume": 750,
    "Revenue": "68230.71",
    "Quantity": "1448"
  },
  {
    "Name": "Sigma Drinks",
    "Date": "04-Dec-2024",
    "Volume": 500,
    "Revenue": "64920.84",
    "Quantity": "1325"
  },
  {
    "Name": "Tau Services",
    "Date": "05-Dec-2024",
    "Volume": 750,
    "Revenue": "48704.15",
    "Quantity": "1181"
  },
  {
    "Name": "Upsilon Logistics",
    "Date": "06-Dec-2024",
    "Volume": 500,
    "Revenue": "56175.58",
    "Quantity": "1217"
  },
  {
    "Name": "Phi Retail",
    "Date": "07-Dec-2024",
    "Volume": 750,
    "Revenue": "25408.46",
    "Quantity": "581"
  },
  {
    "Name": "Chi Wholesalers",
    "Date": "08-Dec-2024",
    "Volume": 500,
    "Revenue": "12839.73",
    "Quantity": "312"
  },
  {
    "Name": "Psi Vendors",
    "Date": "09-Dec-2024",
    "Volume": 750,
    "Revenue": "34458.52",
    "Quantity": "705"
  },
  {
    "Name": "Omega Supplies",
    "Date": "10-Dec-2024",
    "Volume": 500,
    "Revenue": "25271.87",
    "Quantity": "516"
  },
  {
    "Name": "Alpha Brews",
    "Date": "11-Dec-2024",
    "Volume": 750,
    "Revenue": "14240.66",
    "Quantity": "339"
  },
  {
    "Name": "Beta Beverages",
    "Date": "12-Dec-2024",
    "Volume": 500,
    "Revenue": "49000.18",
    "Quantity": "1074"
  },
  {
    "Name": "Gamma Drinks",
    "Date": "13-Dec-2024",
    "Volume": 750,
    "Revenue": "24627.88",
    "Quantity": "539"
  },
  {
    "Name": "Delta Distributors",
    "Date": "14-Dec-2024",
    "Volume": 500,
    "Revenue": "73793.32",
    "Quantity": "1587"
  },
  {
    "Name": "Epsilon Supplies",
    "Date": "15-Dec-2024",
    "Volume": 750,
    "Revenue": "26756.07",
    "Quantity": "537"
  },
  {
    "Name": "Zeta Logistics",
    "Date": "16-Dec-2024",
    "Volume": 500,
    "Revenue": "13130.02",
    "Quantity": "323"
  },
  {
    "Name": "Eta Services",
    "Date": "17-Dec-2024",
    "Volume": 750,
    "Revenue": "49929.97",
    "Quantity": "1025"
  },
  {
    "Name": "Theta Retail",
    "Date": "18-Dec-2024",
    "Volume": 500,
    "Revenue": "41470.72",
    "Quantity": "1020"
  },
  {
    "Name": "Iota Traders",
    "Date": "19-Dec-2024",
    "Volume": 750,
    "Revenue": "79260.01",
    "Quantity": "1758"
  },
  {
    "Name": "Kappa Wholesalers",
    "Date": "20-Dec-2024",
    "Volume": 500,
    "Revenue": "14247.45",
    "Quantity": "318"
  },
  {
    "Name": "Lambda Vendors",
    "Date": "21-Dec-2024",
    "Volume": 750,
    "Revenue": "48175.89",
    "Quantity": "994"
  },
  {
    "Name": "Mu Suppliers",
    "Date": "22-Dec-2024",
    "Volume": 500,
    "Revenue": "73351.67",
    "Quantity": "1482"
  },
  {
    "Name": "Nu Goods",
    "Date": "23-Dec-2024",
    "Volume": 750,
    "Revenue": "75233.73",
    "Quantity": "1570"
  },
  {
    "Name": "Xi Merchants",
    "Date": "24-Dec-2024",
    "Volume": 500,
    "Revenue": "32139.02",
    "Quantity": "779"
  },
  {
    "Name": "Omicron Providers",
    "Date": "25-Dec-2024",
    "Volume": 750,
    "Revenue": "65113.17",
    "Quantity": "1320"
  },
  {
    "Name": "Pi Distributors",
    "Date": "26-Dec-2024",
    "Volume": 500,
    "Revenue": "32328.32",
    "Quantity": "666"
  },
  {
    "Name": "Rho Beverages",
    "Date": "27-Dec-2024",
    "Volume": 750,
    "Revenue": "83640.90",
    "Quantity": "1796"
  },
  {
    "Name": "Sigma Drinks",
    "Date": "28-Dec-2024",
    "Volume": 500,
    "Revenue": "47361.02",
    "Quantity": "957"
  },
  {
    "Name": "Tau Services",
    "Date": "29-Dec-2024",
    "Volume": 750,
    "Revenue": "40047.22",
    "Quantity": "972"
  },
  {
    "Name": "Upsilon Logistics",
    "Date": "30-Dec-2024",
    "Volume": 500,
    "Revenue": "67164.05",
    "Quantity": "1348"
  },
  {
    "Name": "Phi Retail",
    "Date": "31-Dec-2024",
    "Volume": 750,
    "Revenue": "71463.04",
    "Quantity": "1713"
  },
  {
    "Name": "Chi Wholesalers",
    "Date": "01-Jan-2025",
    "Volume": 500,
    "Revenue": "53367.47",
    "Quantity": "1161"
  },
  {
    "Name": "Psi Vendors",
    "Date": "02-Jan-2025",
    "Volume": 750,
    "Revenue": "42113.30",
    "Quantity": "894"
  },
  {
    "Name": "Omega Supplies",
    "Date": "03-Jan-2025",
    "Volume": 500,
    "Revenue": "59251.18",
    "Quantity": "1454"
  },
  {
    "Name": "Alpha Brews",
    "Date": "04-Jan-2025",
    "Volume": 750,
    "Revenue": "71020.48",
    "Quantity": "1632"
  },
  {
    "Name": "Beta Beverages",
    "Date": "05-Jan-2025",
    "Volume": 500,
    "Revenue": "50229.69",
    "Quantity": "1203"
  },
  {
    "Name": "Gamma Drinks",
    "Date": "06-Jan-2025",
    "Volume": 750,
    "Revenue": "64106.21",
    "Quantity": "1417"
  },
  {
    "Name": "Delta Distributors",
    "Date": "07-Jan-2025",
    "Volume": 500,
    "Revenue": "47040.77",
    "Quantity": "1041"
  },
  {
    "Name": "Epsilon Supplies",
    "Date": "08-Jan-2025",
    "Volume": 750,
    "Revenue": "20359.88",
    "Quantity": "487"
  },
  {
    "Name": "Zeta Logistics",
    "Date": "09-Jan-2025",
    "Volume": 500,
    "Revenue": "29660.99",
    "Quantity": "638"
  },
  {
    "Name": "Eta Services",
    "Date": "10-Jan-2025",
    "Volume": 750,
    "Revenue": "28268.12",
    "Quantity": "618"
  },
  {
    "Name": "Theta Retail",
    "Date": "11-Jan-2025",
    "Volume": 500,
    "Revenue": "29331.13",
    "Quantity": "711"
  },
  {
    "Name": "Iota Traders",
    "Date": "12-Jan-2025",
    "Volume": 750,
    "Revenue": "74758.14",
    "Quantity": "1676"
  },
  {
    "Name": "Kappa Wholesalers",
    "Date": "13-Jan-2025",
    "Volume": 500,
    "Revenue": "13064.09",
    "Quantity": "317"
  },
  {
    "Name": "Lambda Vendors",
    "Date": "14-Jan-2025",
    "Volume": 750,
    "Revenue": "21896.86",
    "Quantity": "466"
  },
  {
    "Name": "Mu Suppliers",
    "Date": "15-Jan-2025",
    "Volume": 500,
    "Revenue": "41312.50",
    "Quantity": "984"
  },
  {
    "Name": "Nu Goods",
    "Date": "16-Jan-2025",
    "Volume": 750,
    "Revenue": "24754.14",
    "Quantity": "576"
  },
  {
    "Name": "Xi Merchants",
    "Date": "17-Jan-2025",
    "Volume": 500,
    "Revenue": "55845.07",
    "Quantity": "1297"
  },
  {
    "Name": "Omicron Providers",
    "Date": "18-Jan-2025",
    "Volume": 750,
    "Revenue": "26870.42",
    "Quantity": "585"
  },
  {
    "Name": "Pi Distributors",
    "Date": "19-Jan-2025",
    "Volume": 500,
    "Revenue": "45039.50",
    "Quantity": "1013"
  },
  {
    "Name": "Rho Beverages",
    "Date": "20-Jan-2025",
    "Volume": 750,
    "Revenue": "44938.73",
    "Quantity": "924"
  },
  {
    "Name": "Sigma Drinks",
    "Date": "21-Jan-2025",
    "Volume": 500,
    "Revenue": "82480.68",
    "Quantity": "1791"
  },
  {
    "Name": "Tau Services",
    "Date": "22-Jan-2025",
    "Volume": 750,
    "Revenue": "38271.50",
    "Quantity": "882"
  },
  {
    "Name": "Upsilon Logistics",
    "Date": "23-Jan-2025",
    "Volume": 500,
    "Revenue": "83342.07",
    "Quantity": "1782"
  },
  {
    "Name": "Phi Retail",
    "Date": "24-Jan-2025",
    "Volume": 750,
    "Revenue": "12907.79",
    "Quantity": "314"
  },
  {
    "Name": "Chi Wholesalers",
    "Date": "25-Jan-2025",
    "Volume": 500,
    "Revenue": "15445.06",
    "Quantity": "351"
  },
  {
    "Name": "Psi Vendors",
    "Date": "26-Jan-2025",
    "Volume": 750,
    "Revenue": "32192.59",
    "Quantity": "722"
  },
  {
    "Name": "Omega Supplies",
    "Date": "27-Jan-2025",
    "Volume": 500,
    "Revenue": "72192.48",
    "Quantity": "1459"
  },
  {
    "Name": "Alpha Brews",
    "Date": "28-Jan-2025",
    "Volume": 750,
    "Revenue": "70722.83",
    "Quantity": "1694"
  },
  {
    "Name": "Beta Beverages",
    "Date": "29-Jan-2025",
    "Volume": 500,
    "Revenue": "69612.99",
    "Quantity": "1684"
  },
  {
    "Name": "Gamma Drinks",
    "Date": "30-Jan-2025",
    "Volume": 750,
    "Revenue": "29329.32",
    "Quantity": "678"
  },
  {
    "Name": "Delta Distributors",
    "Date": "31-Jan-2025",
    "Volume": 500,
    "Revenue": "15660.37",
    "Quantity": "342"
  },
  {
    "Name": "Epsilon Supplies",
    "Date": "01-Feb-2025",
    "Volume": 750,
    "Revenue": "46192.81",
    "Quantity": "983"
  },
  {
    "Name": "Zeta Logistics",
    "Date": "02-Feb-2025",
    "Volume": 500,
    "Revenue": "15886.84",
    "Quantity": "386"
  },
  {
    "Name": "Eta Services",
    "Date": "03-Feb-2025",
    "Volume": 750,
    "Revenue": "50706.08",
    "Quantity": "1016"
  },
  {
    "Name": "Theta Retail",
    "Date": "04-Feb-2025",
    "Volume": 500,
    "Revenue": "52123.86",
    "Quantity": "1300"
  },
  {
    "Name": "Iota Traders",
    "Date": "05-Feb-2025",
    "Volume": 750,
    "Revenue": "67803.03",
    "Quantity": "1503"
  },
  {
    "Name": "Kappa Wholesalers",
    "Date": "06-Feb-2025",
    "Volume": 500,
    "Revenue": "74471.33",
    "Quantity": "1514"
  },
  {
    "Name": "Lambda Vendors",
    "Date": "07-Feb-2025",
    "Volume": 750,
    "Revenue": "14979.39",
    "Quantity": "365"
  },
  {
    "Name": "Mu Suppliers",
    "Date": "08-Feb-2025",
    "Volume": 500,
    "Revenue": "80880.35",
    "Quantity": "1742"
  },
  {
    "Name": "Nu Goods",
    "Date": "09-Feb-2025",
    "Volume": 750,
    "Revenue": "63390.97",
    "Quantity": "1361"
  },
  {
    "Name": "Xi Merchants",
    "Date": "10-Feb-2025",
    "Volume": 500,
    "Revenue": "21533.35",
    "Quantity": "455"
  },
  {
    "Name": "Omicron Providers",
    "Date": "11-Feb-2025",
    "Volume": 750,
    "Revenue": "26322.76",
    "Quantity": "556"
  },
  {
    "Name": "Pi Distributors",
    "Date": "12-Feb-2025",
    "Volume": 500,
    "Revenue": "62239.13",
    "Quantity": "1368"
  },
  {
    "Name": "Rho Beverages",
    "Date": "13-Feb-2025",
    "Volume": 750,
    "Revenue": "24430.56",
    "Quantity": "500"
  },
  {
    "Name": "Sigma Drinks",
    "Date": "14-Feb-2025",
    "Volume": 500,
    "Revenue": "27975.41",
    "Quantity": "638"
  },
  {
    "Name": "Tau Services",
    "Date": "15-Feb-2025",
    "Volume": 750,
    "Revenue": "47481.81",
    "Quantity": "1123"
  },
  {
    "Name": "Upsilon Logistics",
    "Date": "16-Feb-2025",
    "Volume": 500,
    "Revenue": "25892.92",
    "Quantity": "635"
  },
  {
    "Name": "Phi Retail",
    "Date": "17-Feb-2025",
    "Volume": 750,
    "Revenue": "40516.13",
    "Quantity": "964"
  },
  {
    "Name": "Chi Wholesalers",
    "Date": "18-Feb-2025",
    "Volume": 500,
    "Revenue": "62912.47",
    "Quantity": "1540"
  },
  {
    "Name": "Psi Vendors",
    "Date": "19-Feb-2025",
    "Volume": 750,
    "Revenue": "47591.83",
    "Quantity": "1187"
  },
  {
    "Name": "Omega Supplies",
    "Date": "20-Feb-2025",
    "Volume": 500,
    "Revenue": "42726.12",
    "Quantity": "1053"
  },
  {
    "Name": "Alpha Brews",
    "Date": "21-Feb-2025",
    "Volume": 750,
    "Revenue": "39055.96",
    "Quantity": "905"
  },
  {
    "Name": "Beta Beverages",
    "Date": "22-Feb-2025",
    "Volume": 500,
    "Revenue": "44333.41",
    "Quantity": "993"
  },
  {
    "Name": "Gamma Drinks",
    "Date": "23-Feb-2025",
    "Volume": 750,
    "Revenue": "17982.36",
    "Quantity": "445"
  },
  {
    "Name": "Delta Distributors",
    "Date": "24-Feb-2025",
    "Volume": 500,
    "Revenue": "62117.02",
    "Quantity": "1280"
  },
  {
    "Name": "Epsilon Supplies",
    "Date": "25-Feb-2025",
    "Volume": 750,
    "Revenue": "64595.96",
    "Quantity": "1404"
  },
  {
    "Name": "Zeta Logistics",
    "Date": "26-Feb-2025",
    "Volume": 500,
    "Revenue": "25727.81",
    "Quantity": "623"
  },
  {
    "Name": "Eta Services",
    "Date": "27-Feb-2025",
    "Volume": 750,
    "Revenue": "21092.96",
    "Quantity": "519"
  },
  {
    "Name": "Theta Retail",
    "Date": "28-Feb-2025",
    "Volume": 500,
    "Revenue": "41349.59",
    "Quantity": "921"
  },
  {
    "Name": "Iota Traders",
    "Date": "01-Mar-2025",
    "Volume": 750,
    "Revenue": "48988.06",
    "Quantity": "984"
  },
  {
    "Name": "Kappa Wholesalers",
    "Date": "02-Mar-2025",
    "Volume": 500,
    "Revenue": "22738.58",
    "Quantity": "499"
  },
  {
    "Name": "Lambda Vendors",
    "Date": "03-Mar-2025",
    "Volume": 750,
    "Revenue": "53645.46",
    "Quantity": "1112"
  },
  {
    "Name": "Mu Suppliers",
    "Date": "04-Mar-2025",
    "Volume": 500,
    "Revenue": "51225.96",
    "Quantity": "1266"
  },
  {
    "Name": "Nu Goods",
    "Date": "05-Mar-2025",
    "Volume": 750,
    "Revenue": "22579.35",
    "Quantity": "535"
  },
  {
    "Name": "Xi Merchants",
    "Date": "06-Mar-2025",
    "Volume": 500,
    "Revenue": "41616.27",
    "Quantity": "885"
  },
  {
    "Name": "Omicron Providers",
    "Date": "07-Mar-2025",
    "Volume": 750,
    "Revenue": "17750.12",
    "Quantity": "426"
  },
  {
    "Name": "Pi Distributors",
    "Date": "08-Mar-2025",
    "Volume": 500,
    "Revenue": "46496.11",
    "Quantity": "1062"
  },
  {
    "Name": "Rho Beverages",
    "Date": "09-Mar-2025",
    "Volume": 750,
    "Revenue": "66162.80",
    "Quantity": "1429"
  },
  {
    "Name": "Sigma Drinks",
    "Date": "10-Mar-2025",
    "Volume": 500,
    "Revenue": "69521.25",
    "Quantity": "1594"
  },
  {
    "Name": "Tau Services",
    "Date": "11-Mar-2025",
    "Volume": 750,
    "Revenue": "40715.13",
    "Quantity": "974"
  },
  {
    "Name": "Upsilon Logistics",
    "Date": "12-Mar-2025",
    "Volume": 500,
    "Revenue": "59098.57",
    "Quantity": "1246"
  },
  {
    "Name": "Phi Retail",
    "Date": "13-Mar-2025",
    "Volume": 750,
    "Revenue": "61322.41",
    "Quantity": "1364"
  },
  {
    "Name": "Chi Wholesalers",
    "Date": "14-Mar-2025",
    "Volume": 500,
    "Revenue": "61291.49",
    "Quantity": "1465"
  },
  {
    "Name": "Psi Vendors",
    "Date": "15-Mar-2025",
    "Volume": 750,
    "Revenue": "54157.24",
    "Quantity": "1148"
  },
  {
    "Name": "Omega Supplies",
    "Date": "16-Mar-2025",
    "Volume": 500,
    "Revenue": "66867.93",
    "Quantity": "1356"
  },
  {
    "Name": "Alpha Brews",
    "Date": "17-Mar-2025",
    "Volume": 750,
    "Revenue": "40647.22",
    "Quantity": "850"
  },
  {
    "Name": "Beta Beverages",
    "Date": "18-Mar-2025",
    "Volume": 500,
    "Revenue": "61698.83",
    "Quantity": "1527"
  },
  {
    "Name": "Gamma Drinks",
    "Date": "19-Mar-2025",
    "Volume": 750,
    "Revenue": "15638.43",
    "Quantity": "340"
  },
  {
    "Name": "Delta Distributors",
    "Date": "20-Mar-2025",
    "Volume": 500,
    "Revenue": "15558.41",
    "Quantity": "378"
  },
  {
    "Name": "Epsilon Supplies",
    "Date": "21-Mar-2025",
    "Volume": 750,
    "Revenue": "23428.44",
    "Quantity": "569"
  },
  {
    "Name": "Zeta Logistics",
    "Date": "22-Mar-2025",
    "Volume": 500,
    "Revenue": "64348.25",
    "Quantity": "1410"
  },
  {
    "Name": "Eta Services",
    "Date": "23-Mar-2025",
    "Volume": 750,
    "Revenue": "17341.37",
    "Quantity": "375"
  },
  {
    "Name": "Theta Retail",
    "Date": "24-Mar-2025",
    "Volume": 500,
    "Revenue": "47259.05",
    "Quantity": "968"
  },
  {
    "Name": "Iota Traders",
    "Date": "25-Mar-2025",
    "Volume": 750,
    "Revenue": "14663.19",
    "Quantity": "345"
  },
  {
    "Name": "Kappa Wholesalers",
    "Date": "26-Mar-2025",
    "Volume": 500,
    "Revenue": "78637.52",
    "Quantity": "1651"
  },
  {
    "Name": "Lambda Vendors",
    "Date": "27-Mar-2025",
    "Volume": 750,
    "Revenue": "81716.63",
    "Quantity": "1717"
  },
  {
    "Name": "Mu Suppliers",
    "Date": "28-Mar-2025",
    "Volume": 500,
    "Revenue": "59368.71",
    "Quantity": "1454"
  },
  {
    "Name": "Nu Goods",
    "Date": "29-Mar-2025",
    "Volume": 750,
    "Revenue": "77159.19",
    "Quantity": "1723"
  },
  {
    "Name": "Xi Merchants",
    "Date": "30-Mar-2025",
    "Volume": 500,
    "Revenue": "82640.36",
    "Quantity": "1688"
  },
  {
    "Name": "Omicron Providers",
    "Date": "31-Mar-2025",
    "Volume": 750,
    "Revenue": "13384.04",
    "Quantity": "328"
  },
  {
    "Name": "Pi Distributors",
    "Date": "01-Apr-2025",
    "Volume": 500,
    "Revenue": "40649.97",
    "Quantity": "893"
  },
  {
    "Name": "Rho Beverages",
    "Date": "02-Apr-2025",
    "Volume": 750,
    "Revenue": "35168.60",
    "Quantity": "866"
  },
  {
    "Name": "Sigma Drinks",
    "Date": "03-Apr-2025",
    "Volume": 500,
    "Revenue": "59922.05",
    "Quantity": "1383"
  },
  {
    "Name": "Tau Services",
    "Date": "04-Apr-2025",
    "Volume": 750,
    "Revenue": "28606.17",
    "Quantity": "632"
  },
  {
    "Name": "Upsilon Logistics",
    "Date": "05-Apr-2025",
    "Volume": 500,
    "Revenue": "27811.06",
    "Quantity": "561"
  },
  {
    "Name": "Phi Retail",
    "Date": "06-Apr-2025",
    "Volume": 750,
    "Revenue": "22389.25",
    "Quantity": "532"
  },
  {
    "Name": "Chi Wholesalers",
    "Date": "07-Apr-2025",
    "Volume": 500,
    "Revenue": "57336.22",
    "Quantity": "1166"
  },
  {
    "Name": "Psi Vendors",
    "Date": "08-Apr-2025",
    "Volume": 750,
    "Revenue": "44128.32",
    "Quantity": "891"
  },
  {
    "Name": "Omega Supplies",
    "Date": "09-Apr-2025",
    "Volume": 500,
    "Revenue": "69701.89",
    "Quantity": "1601"
  },
  {
    "Name": "Alpha Brews",
    "Date": "10-Apr-2025",
    "Volume": 750,
    "Revenue": "27346.42",
    "Quantity": "611"
  },
  {
    "Name": "Beta Beverages",
    "Date": "11-Apr-2025",
    "Volume": 500,
    "Revenue": "53034.02",
    "Quantity": "1230"
  },
  {
    "Name": "Gamma Drinks",
    "Date": "12-Apr-2025",
    "Volume": 750,
    "Revenue": "54186.06",
    "Quantity": "1146"
  },
  {
    "Name": "Delta Distributors",
    "Date": "13-Apr-2025",
    "Volume": 500,
    "Revenue": "59018.73",
    "Quantity": "1207"
  },
  {
    "Name": "Epsilon Supplies",
    "Date": "14-Apr-2025",
    "Volume": 750,
    "Revenue": "54258.28",
    "Quantity": "1184"
  },
  {
    "Name": "Zeta Logistics",
    "Date": "15-Apr-2025",
    "Volume": 500,
    "Revenue": "34861.14",
    "Quantity": "792"
  },
  {
    "Name": "Eta Services",
    "Date": "16-Apr-2025",
    "Volume": 750,
    "Revenue": "50233.98",
    "Quantity": "1062"
  },
  {
    "Name": "Theta Retail",
    "Date": "17-Apr-2025",
    "Volume": 500,
    "Revenue": "18660.84",
    "Quantity": "413"
  },
  {
    "Name": "Iota Traders",
    "Date": "18-Apr-2025",
    "Volume": 750,
    "Revenue": "70833.18",
    "Quantity": "1530"
  },
  {
    "Name": "Kappa Wholesalers",
    "Date": "19-Apr-2025",
    "Volume": 500,
    "Revenue": "32341.51",
    "Quantity": "807"
  },
  {
    "Name": "Lambda Vendors",
    "Date": "20-Apr-2025",
    "Volume": 750,
    "Revenue": "19721.93",
    "Quantity": "489"
  },
  {
    "Name": "Mu Suppliers",
    "Date": "21-Apr-2025",
    "Volume": 500,
    "Revenue": "59497.36",
    "Quantity": "1232"
  },
  {
    "Name": "Nu Goods",
    "Date": "22-Apr-2025",
    "Volume": 750,
    "Revenue": "19745.03",
    "Quantity": "484"
  },
  {
    "Name": "Xi Merchants",
    "Date": "23-Apr-2025",
    "Volume": 500,
    "Revenue": "65753.30",
    "Quantity": "1332"
  },
  {
    "Name": "Omicron Providers",
    "Date": "24-Apr-2025",
    "Volume": 750,
    "Revenue": "18507.36",
    "Quantity": "404"
  },
  {
    "Name": "Pi Distributors",
    "Date": "25-Apr-2025",
    "Volume": 500,
    "Revenue": "62565.12",
    "Quantity": "1276"
  },
  {
    "Name": "Rho Beverages",
    "Date": "26-Apr-2025",
    "Volume": 750,
    "Revenue": "51336.05",
    "Quantity": "1126"
  },
  {
    "Name": "Sigma Drinks",
    "Date": "27-Apr-2025",
    "Volume": 500,
    "Revenue": "29347.00",
    "Quantity": "706"
  },
  {
    "Name": "Tau Services",
    "Date": "28-Apr-2025",
    "Volume": 750,
    "Revenue": "56164.43",
    "Quantity": "1139"
  },
  {
    "Name": "Upsilon Logistics",
    "Date": "29-Apr-2025",
    "Volume": 500,
    "Revenue": "54932.96",
    "Quantity": "1348"
  },
  {
    "Name": "Phi Retail",
    "Date": "30-Apr-2025",
    "Volume": 750,
    "Revenue": "21102.86",
    "Quantity": "475"
  },
  {
    "Name": "Chi Wholesalers",
    "Date": "01-May-2025",
    "Volume": 500,
    "Revenue": "35645.26",
    "Quantity": "824"
  },
  {
    "Name": "Psi Vendors",
    "Date": "02-May-2025",
    "Volume": 750,
    "Revenue": "28416.91",
    "Quantity": "606"
  },
  {
    "Name": "Omega Supplies",
    "Date": "03-May-2025",
    "Volume": 500,
    "Revenue": "79920.28",
    "Quantity": "1604"
  },
  {
    "Name": "Alpha Brews",
    "Date": "04-May-2025",
    "Volume": 750,
    "Revenue": "74743.39",
    "Quantity": "1626"
  },
  {
    "Name": "Beta Beverages",
    "Date": "05-May-2025",
    "Volume": 500,
    "Revenue": "70619.93",
    "Quantity": "1466"
  },
  {
    "Name": "Gamma Drinks",
    "Date": "06-May-2025",
    "Volume": 750,
    "Revenue": "64269.46",
    "Quantity": "1409"
  },
  {
    "Name": "Delta Distributors",
    "Date": "07-May-2025",
    "Volume": 500,
    "Revenue": "50445.28",
    "Quantity": "1010"
  },
  {
    "Name": "Epsilon Supplies",
    "Date": "08-May-2025",
    "Volume": 750,
    "Revenue": "38186.29",
    "Quantity": "881"
  },
  {
    "Name": "Zeta Logistics",
    "Date": "09-May-2025",
    "Volume": 500,
    "Revenue": "69469.50",
    "Quantity": "1428"
  },
  {
    "Name": "Eta Services",
    "Date": "10-May-2025",
    "Volume": 750,
    "Revenue": "74402.65",
    "Quantity": "1614"
  },
  {
    "Name": "Theta Retail",
    "Date": "11-May-2025",
    "Volume": 500,
    "Revenue": "27677.31",
    "Quantity": "624"
  },
  {
    "Name": "Iota Traders",
    "Date": "12-May-2025",
    "Volume": 750,
    "Revenue": "25641.10",
    "Quantity": "576"
  },
  {
    "Name": "Kappa Wholesalers",
    "Date": "13-May-2025",
    "Volume": 500,
    "Revenue": "37575.82",
    "Quantity": "803"
  },
  {
    "Name": "Lambda Vendors",
    "Date": "14-May-2025",
    "Volume": 750,
    "Revenue": "46844.58",
    "Quantity": "1023"
  },
  {
    "Name": "Mu Suppliers",
    "Date": "15-May-2025",
    "Volume": 500,
    "Revenue": "16710.09",
    "Quantity": "348"
  },
  {
    "Name": "Nu Goods",
    "Date": "16-May-2025",
    "Volume": 750,
    "Revenue": "80527.16",
    "Quantity": "1644"
  },
  {
    "Name": "Xi Merchants",
    "Date": "17-May-2025",
    "Volume": 500,
    "Revenue": "46380.08",
    "Quantity": "1015"
  },
  {
    "Name": "Omicron Providers",
    "Date": "18-May-2025",
    "Volume": 750,
    "Revenue": "57095.40",
    "Quantity": "1284"
  },
  {
    "Name": "Pi Distributors",
    "Date": "19-May-2025",
    "Volume": 500,
    "Revenue": "57820.12",
    "Quantity": "1341"
  },
  {
    "Name": "Rho Beverages",
    "Date": "20-May-2025",
    "Volume": 750,
    "Revenue": "42840.73",
    "Quantity": "1053"
  },
  {
    "Name": "Sigma Drinks",
    "Date": "21-May-2025",
    "Volume": 500,
    "Revenue": "45393.22",
    "Quantity": "984"
  },
  {
    "Name": "Tau Services",
    "Date": "22-May-2025",
    "Volume": 750,
    "Revenue": "55236.79",
    "Quantity": "1301"
  },
  {
    "Name": "Upsilon Logistics",
    "Date": "23-May-2025",
    "Volume": 500,
    "Revenue": "20943.00",
    "Quantity": "455"
  },
  {
    "Name": "Phi Retail",
    "Date": "24-May-2025",
    "Volume": 750,
    "Revenue": "69675.24",
    "Quantity": "1649"
  },
  {
    "Name": "Chi Wholesalers",
    "Date": "25-May-2025",
    "Volume": 500,
    "Revenue": "58594.34",
    "Quantity": "1234"
  },
  {
    "Name": "Psi Vendors",
    "Date": "26-May-2025",
    "Volume": 750,
    "Revenue": "49066.34",
    "Quantity": "1195"
  },
  {
    "Name": "Omega Supplies",
    "Date": "27-May-2025",
    "Volume": 500,
    "Revenue": "65172.92",
    "Quantity": "1619"
  },
  {
    "Name": "Alpha Brews",
    "Date": "28-May-2025",
    "Volume": 750,
    "Revenue": "64872.79",
    "Quantity": "1339"
  },
  {
    "Name": "Beta Beverages",
    "Date": "29-May-2025",
    "Volume": 500,
    "Revenue": "33466.08",
    "Quantity": "822"
  },
  {
    "Name": "Gamma Drinks",
    "Date": "30-May-2025",
    "Volume": 750,
    "Revenue": "59859.33",
    "Quantity": "1294"
  },
  {
    "Name": "Delta Distributors",
    "Date": "31-May-2025",
    "Volume": 500,
    "Revenue": "31695.10",
    "Quantity": "713"
  },
  {
    "Name": "Epsilon Supplies",
    "Date": "01-Jun-2025",
    "Volume": 750,
    "Revenue": "34428.12",
    "Quantity": "782"
  },
  {
    "Name": "Zeta Logistics",
    "Date": "02-Jun-2025",
    "Volume": 500,
    "Revenue": "48260.18",
    "Quantity": "1185"
  },
  {
    "Name": "Eta Services",
    "Date": "03-Jun-2025",
    "Volume": 750,
    "Revenue": "23290.90",
    "Quantity": "471"
  },
  {
    "Name": "Theta Retail",
    "Date": "04-Jun-2025",
    "Volume": 500,
    "Revenue": "69671.16",
    "Quantity": "1568"
  },
  {
    "Name": "Iota Traders",
    "Date": "05-Jun-2025",
    "Volume": 750,
    "Revenue": "13759.20",
    "Quantity": "304"
  },
  {
    "Name": "Kappa Wholesalers",
    "Date": "06-Jun-2025",
    "Volume": 500,
    "Revenue": "35941.72",
    "Quantity": "835"
  },
  {
    "Name": "Lambda Vendors",
    "Date": "07-Jun-2025",
    "Volume": 750,
    "Revenue": "61532.52",
    "Quantity": "1366"
  },
  {
    "Name": "Mu Suppliers",
    "Date": "08-Jun-2025",
    "Volume": 500,
    "Revenue": "29004.94",
    "Quantity": "581"
  },
  {
    "Name": "Nu Goods",
    "Date": "09-Jun-2025",
    "Volume": 750,
    "Revenue": "20689.83",
    "Quantity": "459"
  },
  {
    "Name": "Xi Merchants",
    "Date": "10-Jun-2025",
    "Volume": 500,
    "Revenue": "57100.37",
    "Quantity": "1342"
  },
  {
    "Name": "Omicron Providers",
    "Date": "11-Jun-2025",
    "Volume": 750,
    "Revenue": "20455.75",
    "Quantity": "477"
  },
  {
    "Name": "Pi Distributors",
    "Date": "12-Jun-2025",
    "Volume": 500,
    "Revenue": "80606.90",
    "Quantity": "1793"
  },
  {
    "Name": "Rho Beverages",
    "Date": "13-Jun-2025",
    "Volume": 750,
    "Revenue": "88642.84",
    "Quantity": "1800"
  },
  {
    "Name": "Sigma Drinks",
    "Date": "14-Jun-2025",
    "Volume": 500,
    "Revenue": "73036.02",
    "Quantity": "1762"
  },
  {
    "Name": "Tau Services",
    "Date": "15-Jun-2025",
    "Volume": 750,
    "Revenue": "26172.80",
    "Quantity": "583"
  },
  {
    "Name": "Upsilon Logistics",
    "Date": "16-Jun-2025",
    "Volume": 500,
    "Revenue": "70573.71",
    "Quantity": "1757"
  },
  {
    "Name": "Phi Retail",
    "Date": "17-Jun-2025",
    "Volume": 750,
    "Revenue": "14875.67",
    "Quantity": "371"
  },
  {
    "Name": "Chi Wholesalers",
    "Date": "18-Jun-2025",
    "Volume": 500,
    "Revenue": "19043.38",
    "Quantity": "388"
  },
  {
    "Name": "Psi Vendors",
    "Date": "19-Jun-2025",
    "Volume": 750,
    "Revenue": "17408.81",
    "Quantity": "355"
  },
  {
    "Name": "Omega Supplies",
    "Date": "20-Jun-2025",
    "Volume": 500,
    "Revenue": "24663.96",
    "Quantity": "611"
  },
  {
    "Name": "Alpha Brews",
    "Date": "21-Jun-2025",
    "Volume": 750,
    "Revenue": "51347.97",
    "Quantity": "1144"
  },
  {
    "Name": "Beta Beverages",
    "Date": "22-Jun-2025",
    "Volume": 500,
    "Revenue": "43998.64",
    "Quantity": "923"
  },
  {
    "Name": "Gamma Drinks",
    "Date": "23-Jun-2025",
    "Volume": 750,
    "Revenue": "76678.47",
    "Quantity": "1571"
  },
  {
    "Name": "Delta Distributors",
    "Date": "24-Jun-2025",
    "Volume": 500,
    "Revenue": "41387.36",
    "Quantity": "947"
  },
  {
    "Name": "Epsilon Supplies",
    "Date": "25-Jun-2025",
    "Volume": 750,
    "Revenue": "61641.37",
    "Quantity": "1290"
  },
  {
    "Name": "Zeta Logistics",
    "Date": "26-Jun-2025",
    "Volume": 500,
    "Revenue": "39468.24",
    "Quantity": "873"
  },
  {
    "Name": "Eta Services",
    "Date": "27-Jun-2025",
    "Volume": 750,
    "Revenue": "72597.04",
    "Quantity": "1674"
  },
  {
    "Name": "Theta Retail",
    "Date": "28-Jun-2025",
    "Volume": 500,
    "Revenue": "15646.74",
    "Quantity": "336"
  },
  {
    "Name": "Iota Traders",
    "Date": "29-Jun-2025",
    "Volume": 750,
    "Revenue": "47659.74",
    "Quantity": "972"
  },
  {
    "Name": "Kappa Wholesalers",
    "Date": "30-Jun-2025",
    "Volume": 500,
    "Revenue": "56734.80",
    "Quantity": "1297"
  },
  {
    "Name": "Lambda Vendors",
    "Date": "01-Jul-2025",
    "Volume": 750,
    "Revenue": "68449.53",
    "Quantity": "1685"
  },
  {
    "Name": "Mu Suppliers",
    "Date": "02-Jul-2025",
    "Volume": 500,
    "Revenue": "42366.71",
    "Quantity": "996"
  },
  {
    "Name": "Nu Goods",
    "Date": "03-Jul-2025",
    "Volume": 750,
    "Revenue": "47783.71",
    "Quantity": "972"
  },
  {
    "Name": "Xi Merchants",
    "Date": "04-Jul-2025",
    "Volume": 500,
    "Revenue": "69025.42",
    "Quantity": "1394"
  },
  {
    "Name": "Omicron Providers",
    "Date": "05-Jul-2025",
    "Volume": 750,
    "Revenue": "79523.36",
    "Quantity": "1777"
  },
  {
    "Name": "Pi Distributors",
    "Date": "06-Jul-2025",
    "Volume": 500,
    "Revenue": "59122.49",
    "Quantity": "1361"
  },
  {
    "Name": "Rho Beverages",
    "Date": "07-Jul-2025",
    "Volume": 750,
    "Revenue": "48911.45",
    "Quantity": "1023"
  },
  {
    "Name": "Sigma Drinks",
    "Date": "08-Jul-2025",
    "Volume": 500,
    "Revenue": "21846.37",
    "Quantity": "535"
  },
  {
    "Name": "Tau Services",
    "Date": "09-Jul-2025",
    "Volume": 750,
    "Revenue": "34130.48",
    "Quantity": "768"
  },
  {
    "Name": "Upsilon Logistics",
    "Date": "10-Jul-2025",
    "Volume": 500,
    "Revenue": "45254.97",
    "Quantity": "993"
  },
  {
    "Name": "Phi Retail",
    "Date": "11-Jul-2025",
    "Volume": 750,
    "Revenue": "16679.00",
    "Quantity": "383"
  },
  {
    "Name": "Chi Wholesalers",
    "Date": "12-Jul-2025",
    "Volume": 500,
    "Revenue": "35155.41",
    "Quantity": "791"
  },
  {
    "Name": "Psi Vendors",
    "Date": "13-Jul-2025",
    "Volume": 750,
    "Revenue": "36097.64",
    "Quantity": "832"
  },
  {
    "Name": "Omega Supplies",
    "Date": "14-Jul-2025",
    "Volume": 500,
    "Revenue": "22839.94",
    "Quantity": "532"
  },
  {
    "Name": "Alpha Brews",
    "Date": "15-Jul-2025",
    "Volume": 750,
    "Revenue": "19533.84",
    "Quantity": "400"
  },
  {
    "Name": "Beta Beverages",
    "Date": "16-Jul-2025",
    "Volume": 500,
    "Revenue": "16151.94",
    "Quantity": "349"
  },
  {
    "Name": "Gamma Drinks",
    "Date": "17-Jul-2025",
    "Volume": 750,
    "Revenue": "33433.83",
    "Quantity": "742"
  },
  {
    "Name": "Delta Distributors",
    "Date": "18-Jul-2025",
    "Volume": 500,
    "Revenue": "71453.52",
    "Quantity": "1577"
  },
  {
    "Name": "Epsilon Supplies",
    "Date": "19-Jul-2025",
    "Volume": 750,
    "Revenue": "66452.44",
    "Quantity": "1452"
  },
  {
    "Name": "Zeta Logistics",
    "Date": "20-Jul-2025",
    "Volume": 500,
    "Revenue": "87368.51",
    "Quantity": "1797"
  },
  {
    "Name": "Eta Services",
    "Date": "21-Jul-2025",
    "Volume": 750,
    "Revenue": "31743.42",
    "Quantity": "689"
  },
  {
    "Name": "Theta Retail",
    "Date": "22-Jul-2025",
    "Volume": 500,
    "Revenue": "76671.94",
    "Quantity": "1695"
  },
  {
    "Name": "Iota Traders",
    "Date": "23-Jul-2025",
    "Volume": 750,
    "Revenue": "25051.88",
    "Quantity": "612"
  },
  {
    "Name": "Kappa Wholesalers",
    "Date": "24-Jul-2025",
    "Volume": 500,
    "Revenue": "72589.01",
    "Quantity": "1559"
  },
  {
    "Name": "Lambda Vendors",
    "Date": "25-Jul-2025",
    "Volume": 750,
    "Revenue": "33539.28",
    "Quantity": "768"
  },
  {
    "Name": "Mu Suppliers",
    "Date": "26-Jul-2025",
    "Volume": 500,
    "Revenue": "48124.12",
    "Quantity": "1095"
  },
  {
    "Name": "Nu Goods",
    "Date": "27-Jul-2025",
    "Volume": 750,
    "Revenue": "78219.84",
    "Quantity": "1748"
  },
  {
    "Name": "Xi Merchants",
    "Date": "28-Jul-2025",
    "Volume": 500,
    "Revenue": "51828.77",
    "Quantity": "1143"
  },
  {
    "Name": "Omicron Providers",
    "Date": "29-Jul-2025",
    "Volume": 750,
    "Revenue": "39851.81",
    "Quantity": "850"
  },
  {
    "Name": "Pi Distributors",
    "Date": "30-Jul-2025",
    "Volume": 500,
    "Revenue": "19464.68",
    "Quantity": "451"
  },
  {
    "Name": "Rho Beverages",
    "Date": "31-Jul-2025",
    "Volume": 750,
    "Revenue": "22505.21",
    "Quantity": "513"
  },
  {
    "Name": "Sigma Drinks",
    "Date": "01-Aug-2025",
    "Volume": 500,
    "Revenue": "75733.65",
    "Quantity": "1570"
  },
  {
    "Name": "Tau Services",
    "Date": "02-Aug-2025",
    "Volume": 750,
    "Revenue": "34438.65",
    "Quantity": "696"
  },
  {
    "Name": "Upsilon Logistics",
    "Date": "03-Aug-2025",
    "Volume": 500,
    "Revenue": "18771.85",
    "Quantity": "415"
  },
  {
    "Name": "Phi Retail",
    "Date": "04-Aug-2025",
    "Volume": 750,
    "Revenue": "23191.63",
    "Quantity": "538"
  },
  {
    "Name": "Chi Wholesalers",
    "Date": "05-Aug-2025",
    "Volume": 500,
    "Revenue": "71382.51",
    "Quantity": "1457"
  },
  {
    "Name": "Psi Vendors",
    "Date": "06-Aug-2025",
    "Volume": 750,
    "Revenue": "69265.09",
    "Quantity": "1457"
  },
  {
    "Name": "Omega Supplies",
    "Date": "07-Aug-2025",
    "Volume": 500,
    "Revenue": "62980.15",
    "Quantity": "1475"
  },
  {
    "Name": "Alpha Brews",
    "Date": "08-Aug-2025",
    "Volume": 750,
    "Revenue": "16999.43",
    "Quantity": "375"
  },
  {
    "Name": "Beta Beverages",
    "Date": "09-Aug-2025",
    "Volume": 500,
    "Revenue": "30373.83",
    "Quantity": "707"
  },
  {
    "Name": "Gamma Drinks",
    "Date": "10-Aug-2025",
    "Volume": 750,
    "Revenue": "67141.51",
    "Quantity": "1641"
  },
  {
    "Name": "Delta Distributors",
    "Date": "11-Aug-2025",
    "Volume": 500,
    "Revenue": "62059.94",
    "Quantity": "1432"
  },
  {
    "Name": "Epsilon Supplies",
    "Date": "12-Aug-2025",
    "Volume": 750,
    "Revenue": "58800.02",
    "Quantity": "1211"
  },
  {
    "Name": "Zeta Logistics",
    "Date": "13-Aug-2025",
    "Volume": 500,
    "Revenue": "14441.50",
    "Quantity": "306"
  },
  {
    "Name": "Eta Services",
    "Date": "14-Aug-2025",
    "Volume": 750,
    "Revenue": "66144.05",
    "Quantity": "1382"
  },
  {
    "Name": "Theta Retail",
    "Date": "15-Aug-2025",
    "Volume": 500,
    "Revenue": "16904.15",
    "Quantity": "347"
  },
  {
    "Name": "Iota Traders",
    "Date": "16-Aug-2025",
    "Volume": 750,
    "Revenue": "85068.00",
    "Quantity": "1750"
  },
  {
    "Name": "Kappa Wholesalers",
    "Date": "17-Aug-2025",
    "Volume": 500,
    "Revenue": "69328.54",
    "Quantity": "1589"
  },
  {
    "Name": "Lambda Vendors",
    "Date": "18-Aug-2025",
    "Volume": 750,
    "Revenue": "57259.93",
    "Quantity": "1420"
  },
  {
    "Name": "Mu Suppliers",
    "Date": "19-Aug-2025",
    "Volume": 500,
    "Revenue": "15993.22",
    "Quantity": "341"
  },
  {
    "Name": "Nu Goods",
    "Date": "20-Aug-2025",
    "Volume": 750,
    "Revenue": "43577.25",
    "Quantity": "1064"
  },
  {
    "Name": "Xi Merchants",
    "Date": "21-Aug-2025",
    "Volume": 500,
    "Revenue": "29584.30",
    "Quantity": "683"
  },
  {
    "Name": "Omicron Providers",
    "Date": "22-Aug-2025",
    "Volume": 750,
    "Revenue": "32871.51",
    "Quantity": "723"
  },
  {
    "Name": "Pi Distributors",
    "Date": "23-Aug-2025",
    "Volume": 500,
    "Revenue": "20650.73",
    "Quantity": "486"
  },
  {
    "Name": "Rho Beverages",
    "Date": "24-Aug-2025",
    "Volume": 750,
    "Revenue": "26220.95",
    "Quantity": "557"
  },
  {
    "Name": "Sigma Drinks",
    "Date": "25-Aug-2025",
    "Volume": 500,
    "Revenue": "23407.68",
    "Quantity": "553"
  },
  {
    "Name": "Tau Services",
    "Date": "26-Aug-2025",
    "Volume": 750,
    "Revenue": "19406.17",
    "Quantity": "449"
  },
  {
    "Name": "Upsilon Logistics",
    "Date": "27-Aug-2025",
    "Volume": 500,
    "Revenue": "48626.74",
    "Quantity": "1120"
  },
  {
    "Name": "Phi Retail",
    "Date": "28-Aug-2025",
    "Volume": 750,
    "Revenue": "78577.51",
    "Quantity": "1673"
  },
  {
    "Name": "Chi Wholesalers",
    "Date": "29-Aug-2025",
    "Volume": 500,
    "Revenue": "39226.71",
    "Quantity": "803"
  },
  {
    "Name": "Psi Vendors",
    "Date": "30-Aug-2025",
    "Volume": 750,
    "Revenue": "23315.85",
    "Quantity": "487"
  },
  {
    "Name": "Omega Supplies",
    "Date": "31-Aug-2025",
    "Volume": 500,
    "Revenue": "47887.14",
    "Quantity": "1088"
  },
  {
    "Name": "Alpha Brews",
    "Date": "01-Sep-2025",
    "Volume": 750,
    "Revenue": "47234.09",
    "Quantity": "980"
  },
  {
    "Name": "Beta Beverages",
    "Date": "02-Sep-2025",
    "Volume": 500,
    "Revenue": "24197.36",
    "Quantity": "527"
  },
  {
    "Name": "Gamma Drinks",
    "Date": "03-Sep-2025",
    "Volume": 750,
    "Revenue": "25382.00",
    "Quantity": "510"
  },
  {
    "Name": "Delta Distributors",
    "Date": "04-Sep-2025",
    "Volume": 500,
    "Revenue": "40893.80",
    "Quantity": "819"
  },
  {
    "Name": "Epsilon Supplies",
    "Date": "05-Sep-2025",
    "Volume": 750,
    "Revenue": "66373.18",
    "Quantity": "1364"
  },
  {
    "Name": "Zeta Logistics",
    "Date": "06-Sep-2025",
    "Volume": 500,
    "Revenue": "14948.22",
    "Quantity": "325"
  },
  {
    "Name": "Eta Services",
    "Date": "07-Sep-2025",
    "Volume": 750,
    "Revenue": "32259.68",
    "Quantity": "707"
  },
  {
    "Name": "Theta Retail",
    "Date": "08-Sep-2025",
    "Volume": 500,
    "Revenue": "24085.39",
    "Quantity": "554"
  },
  {
    "Name": "Iota Traders",
    "Date": "09-Sep-2025",
    "Volume": 750,
    "Revenue": "18711.60",
    "Quantity": "377"
  },
  {
    "Name": "Kappa Wholesalers",
    "Date": "10-Sep-2025",
    "Volume": 500,
    "Revenue": "14692.02",
    "Quantity": "335"
  },
  {
    "Name": "Lambda Vendors",
    "Date": "11-Sep-2025",
    "Volume": 750,
    "Revenue": "72480.17",
    "Quantity": "1717"
  },
  {
    "Name": "Mu Suppliers",
    "Date": "12-Sep-2025",
    "Volume": 500,
    "Revenue": "24331.94",
    "Quantity": "581"
  },
  {
    "Name": "Nu Goods",
    "Date": "13-Sep-2025",
    "Volume": 750,
    "Revenue": "69418.88",
    "Quantity": "1670"
  },
  {
    "Name": "Xi Merchants",
    "Date": "14-Sep-2025",
    "Volume": 500,
    "Revenue": "52573.91",
    "Quantity": "1264"
  },
  {
    "Name": "Omicron Providers",
    "Date": "15-Sep-2025",
    "Volume": 750,
    "Revenue": "82416.53",
    "Quantity": "1728"
  },
  {
    "Name": "Pi Distributors",
    "Date": "16-Sep-2025",
    "Volume": 500,
    "Revenue": "73408.79",
    "Quantity": "1565"
  },
  {
    "Name": "Rho Beverages",
    "Date": "17-Sep-2025",
    "Volume": 750,
    "Revenue": "88554.38",
    "Quantity": "1775"
  },
  {
    "Name": "Sigma Drinks",
    "Date": "18-Sep-2025",
    "Volume": 500,
    "Revenue": "12580.41",
    "Quantity": "303"
  },
  {
    "Name": "Tau Services",
    "Date": "19-Sep-2025",
    "Volume": 750,
    "Revenue": "42292.43",
    "Quantity": "997"
  },
  {
    "Name": "Upsilon Logistics",
    "Date": "20-Sep-2025",
    "Volume": 500,
    "Revenue": "49996.66",
    "Quantity": "1121"
  },
  {
    "Name": "Phi Retail",
    "Date": "21-Sep-2025",
    "Volume": 750,
    "Revenue": "27853.00",
    "Quantity": "647"
  },
  {
    "Name": "Chi Wholesalers",
    "Date": "22-Sep-2025",
    "Volume": 500,
    "Revenue": "58913.12",
    "Quantity": "1211"
  },
  {
    "Name": "Psi Vendors",
    "Date": "23-Sep-2025",
    "Volume": 750,
    "Revenue": "29255.92",
    "Quantity": "605"
  },
  {
    "Name": "Omega Supplies",
    "Date": "24-Sep-2025",
    "Volume": 500,
    "Revenue": "29832.45",
    "Quantity": "601"
  },
  {
    "Name": "Alpha Brews",
    "Date": "25-Sep-2025",
    "Volume": 750,
    "Revenue": "29711.99",
    "Quantity": "639"
  },
  {
    "Name": "Beta Beverages",
    "Date": "26-Sep-2025",
    "Volume": 500,
    "Revenue": "46538.49",
    "Quantity": "1016"
  },
  {
    "Name": "Gamma Drinks",
    "Date": "27-Sep-2025",
    "Volume": 750,
    "Revenue": "69763.01",
    "Quantity": "1722"
  },
  {
    "Name": "Delta Distributors",
    "Date": "28-Sep-2025",
    "Volume": 500,
    "Revenue": "45101.93",
    "Quantity": "991"
  },
  {
    "Name": "Epsilon Supplies",
    "Date": "29-Sep-2025",
    "Volume": 750,
    "Revenue": "30917.41",
    "Quantity": "711"
  },
  {
    "Name": "Zeta Logistics",
    "Date": "30-Sep-2025",
    "Volume": 500,
    "Revenue": "73018.06",
    "Quantity": "1591"
  },
  {
    "Name": "Eta Services",
    "Date": "01-Oct-2025",
    "Volume": 750,
    "Revenue": "71824.11",
    "Quantity": "1470"
  },
  {
    "Name": "Theta Retail",
    "Date": "02-Oct-2025",
    "Volume": 500,
    "Revenue": "38180.22",
    "Quantity": "786"
  },
  {
    "Name": "Iota Traders",
    "Date": "03-Oct-2025",
    "Volume": 750,
    "Revenue": "51576.77",
    "Quantity": "1180"
  },
  {
    "Name": "Kappa Wholesalers",
    "Date": "04-Oct-2025",
    "Volume": 500,
    "Revenue": "79567.81",
    "Quantity": "1721"
  },
  {
    "Name": "Lambda Vendors",
    "Date": "05-Oct-2025",
    "Volume": 750,
    "Revenue": "17188.18",
    "Quantity": "402"
  },
  {
    "Name": "Mu Suppliers",
    "Date": "06-Oct-2025",
    "Volume": 500,
    "Revenue": "14272.89",
    "Quantity": "309"
  },
  {
    "Name": "Nu Goods",
    "Date": "07-Oct-2025",
    "Volume": 750,
    "Revenue": "53442.16",
    "Quantity": "1186"
  },
  {
    "Name": "Xi Merchants",
    "Date": "08-Oct-2025",
    "Volume": 500,
    "Revenue": "23473.56",
    "Quantity": "586"
  },
  {
    "Name": "Omicron Providers",
    "Date": "09-Oct-2025",
    "Volume": 750,
    "Revenue": "43591.10",
    "Quantity": "904"
  },
  {
    "Name": "Pi Distributors",
    "Date": "10-Oct-2025",
    "Volume": 500,
    "Revenue": "70487.56",
    "Quantity": "1558"
  },
  {
    "Name": "Rho Beverages",
    "Date": "11-Oct-2025",
    "Volume": 750,
    "Revenue": "75029.51",
    "Quantity": "1551"
  },
  {
    "Name": "Sigma Drinks",
    "Date": "12-Oct-2025",
    "Volume": 500,
    "Revenue": "16723.87",
    "Quantity": "388"
  },
  {
    "Name": "Tau Services",
    "Date": "13-Oct-2025",
    "Volume": 750,
    "Revenue": "51996.51",
    "Quantity": "1132"
  },
  {
    "Name": "Upsilon Logistics",
    "Date": "14-Oct-2025",
    "Volume": 500,
    "Revenue": "46319.92",
    "Quantity": "1080"
  }
]`
const rawData = result;

        if (typeof rawData === "string") {
            console.log("Data is string, attempting to parse...");
            cachedData = JSON.parse(rawData);
        } else {
            cachedData = rawData;
        }
        cacheTime = Date.now();

        return cachedData;
    }

    app.get('/', async (req, res) => {
        if(req.session.loggedIn)
        {
            res.redirect('/dashboard');
        }
        else{
            res.render('login');
        }
    });

    app.post('/login', async (req, res) => {
        try {
            if (process.env.NODE_ENV === 'development') {
                req.session.loggedIn = true;
                return res.redirect('/dashboard');
            }

            const { username, password } = req.body;
            if (username === process.env.USER_NAME && password === process.env.PASSWORD) {
                req.session.loggedIn = true;
                res.redirect('/dashboard');
            } else {
              res.send('Invalid Credentials');
            }
        } catch (error) {
            res.status(500).send('Internal Server Error');
        }
    });


    app.get('/dashboard', isAuthenticated, async(req, res) => {
        try {
            const data = await fetchData();
            if (!Array.isArray(data)) {
                console.error('Invalid data format received:', data);
                return res.status(500).send('Unexpected data format');
            }
            const {totalQuantity,totalRevenue, totalVolume} = buildDashboard(data);
            res.render('index', {totalQuantity,totalRevenue, totalVolume});
        } catch (error) {
            logger.error('Error fetching dashboard data:', error.message);
            res.status(500).send('Internal Server Error');
        }
    });

    app.get('/monthlyCohort', isAuthenticated,async (req, res) => {
        try {
            const data = await fetchData();
            if (!Array.isArray(data)) {
                console.error('Invalid data format received:', data);
                return res.status(500).send('Unexpected data format');
            }
            const {AllNames, customerDictionary,onboardedByMonth, offboardedByMonth, totalOnboardedTillDate} = await ClientNames(data,0);
            const { BrandMonthlyData, sortedUniqueMonths, MonthlyTotals } = buildRevenueCohorts(data);
            res.render('monthlyCohort', { BrandMonthlyData, sortedUniqueMonths, MonthlyTotals,customerDictionary,onboardedByMonth, offboardedByMonth, totalOnboardedTillDate});
        } catch (error) {
            console.error('Error fetching data:', error.message);
            res.status(500).send('Internal Server Error');
        }
    });

    app.get('/weeklyCohort', isAuthenticated,async (req, res) => {
        try {
            const data = await fetchData();
            if (!Array.isArray(data)) {
                console.error('Invalid data format received');
                return res.status(500).send('Unexpected data format');
            }
            const {AllNames, customerDictionary} = await ClientNames(data,1);
            const year = req.query.year || moment().year();
            const { BrandWeeklyData, sortedUniqueWeeks, weeklyTotal} = buildWeeklyCohorts(data, year, AllNames);
            res.render('weeklyCohort', { BrandWeeklyData, sortedUniqueWeeks, weeklyTotal, customerDictionary});
        } catch (error) {
            console.error('Error fetching weekly cohort data:', error.message);
            res.status(500).send('Internal Server Error');
        }
    });

    app.get('/dailyCohort', isAuthenticated,async (req, res) => {
        try {
            const data = await fetchData();
            // buildRevenueCohorts(data);
            if (!Array.isArray(data)) {
                console.error('Invalid data format received:', data);
                return res.status(500).send('Unexpected data format');
            }

            const {month} = req.query;
            let filteredData = data;
            const {AllNames, customerDictionary} = await ClientNames(data,1);
            const { BrandDailyData, sortedUniqueDays, DailyTotals, daysSinceLastOrder,orderCounts} = buildDailyRevenueCohorts(filteredData, month, customerDictionary, AllNames);
            res.render('dailyCohort', { BrandDailyData, sortedUniqueDays, DailyTotals, daysSinceLastOrder,customerDictionary,orderCounts });
        } catch (error) {
            console.error('Error fetching daily revenue data:', error.message);
            res.status(500).send('Internal Server Error');
        }
    });

    app.get('/quantityChart', async(req,res)=>{
        try {
            const data = await fetchData();
            if (!Array.isArray(data)) {
                console.error('Invalid data format received:'   , data);
                return res.status(500).send('Unexpected data format');
            }
            let year = req.query.year || moment().year();
            console.log(year);
            const weeklyData = buildWeeklyCohortsWithBrandWeeks(data, year)
            const weeklyDatas = weeklyData.BrandWeeklyData
            // console.log(weeklyData.data);
            const customersData = Object.keys(weeklyDatas).map(brandName => {
                return {
                name: brandName,
                weeks: weeklyDatas[brandName].Week,
                quantities: weeklyDatas[brandName].Quantity
                };
            });
            res.render('quantityChart',{customersData:customersData, req: req});
        } catch (error) {
            res.status(500).send('Internal Server Error');
            console.log(error);
        }
    });

    app.get('/revenueChart', async(req,res)=>{
        try {
            const data = await fetchData();
            if (!Array.isArray(data)) {
                console.error('Invalid data format received:', data);
                return res.status(500).send('Unexpected data format');
            }
            let year = req.query.year || moment().year();
            console.log(year);
            const weeklyData = buildWeeklyChartRevenue(data, year)
            const weeklyDatas = weeklyData.BrandWeeklyData
            // console.log(weeklyData.data);
            const customersRevenueData = Object.keys(weeklyDatas).map(brandName => {
                return {
                name: brandName,
                weeks: weeklyDatas[brandName].Week,
                revenues: weeklyDatas[brandName].Revenue
                };
            });
            res.render('revenueChart',{customersData:customersRevenueData, req: req});
        } catch (error) {
            res.status(500).send('Internal Server Error');
            console.log(error);
        }
    });
    // app.get('/data', (req, res) => {
    //     const data = [
    //       { x: ['Jan', 'Feb', 'Mar', 'Apr'], y: [30, 40, 35, 50] }
    //     ];
    //     res.json(data);
    //   });

    // app.get('/customerDirectory', async(req,res)=>{
    //     const customerData = await getCustomerData();
    //     res.render('customerDirectory',{customerData});
    // });

    // ... existing code ...

    app.get('/customerDirectory', async(req, res) => {
        try {
            const customerData = await getCustomerData();
            const data = await fetchData();
            
            const brandTotals = new Map();
            const outletTotals = new Map();
            
            data.forEach(({ Name, Revenue, Quantity }) => {
                if (Name) {
                    const trimmedName = Name.trim();
                    
                    if (!brandTotals.has(trimmedName)) {
                        brandTotals.set(trimmedName, {
                            revenue: 0,
                            quantity: 0
                        });
                    }
                    
                    const brandTotal = brandTotals.get(trimmedName);
                    brandTotal.revenue += parseFloat(Revenue) || 0;
                    brandTotal.quantity += parseInt(Quantity, 10) || 0;
                }
            });
            console.log(outletTotals);
            res.render('customerDirectory', {
                customerData,
                brandTotals: Object.fromEntries(brandTotals),
                outletTotals: Object.fromEntries(outletTotals)
            });
        } catch (error) {
            logger.error('Error in customerDirectory route:', error);
            res.status(500).send('Internal Server Error');
        }
    });

    app.listen(port, () => {
        console.log(`Server is running on port: ${port}`);
    });