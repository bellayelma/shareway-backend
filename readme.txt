src/
├── app.js                    # 🚀 MAIN STARTING POINT - Initializes everything
├── config/                   # ⚙️ CONFIGURATION FILES
│   ├── constants.js          # 📝 ALL SETTINGS in one place (timeouts, names, limits)
│   └── firebase.js           # 🔥 Firebase connection setup (ONCE at startup)
├── services/                 # 🛠️ WORKER SERVICES (do the actual work)
│   ├── firestoreService.js   # 💾 SMART Database handler (REDUCES Firestore calls)
│   ├── searchService.js      # 🔍 Manages active searches in MEMORY
│   ├── matchingService.js    # 🤝 Finds matches between drivers/passengers
│   ├── scheduledService.js   # 📅 Handles future/scheduled rides
│   ├── rideService.js        # 🚗 Manages accepted rides & locations
│   └── notificationService.js # 📱 WebSocket notifications
├── controllers/              # 🎮 API ENDPOINT HANDLERS
│   ├── matchController.js    # ↔️ Match-related endpoints
│   ├── searchController.js   # 🔎 Search endpoints
│   ├── driverController.js   # 🚗 Driver-specific endpoints
│   ├── passengerController.js # 👤 Passenger-specific endpoints
│   └── rideController.js     # 🚘 Ride management endpoints
├── middlewares/              # 🛡️ REQUEST PROCESSORS
│   ├── logging.js           # 📝 Smart logging (REDUCES log spam)
│   └── validation.js        # ✅ Input validation
├── utils/                    # 🧰 TOOLBOX FUNCTIONS
│   ├── routeMatching.js     # 🧮 Calculates if routes match
│   ├── schedulerouteMatching.js # ⏰ Future ride matching
│   ├── cache.js             # 🗃️ In-memory storage (REDUCES Firestore reads)
│   └── helpers.js           # 🔧 Helper functions (distance, ID generation)
└── websocketServer.js       # 🔌 Real-time notifications
