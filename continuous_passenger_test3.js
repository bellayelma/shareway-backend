// scheduled_passenger_test.js - EXACT driver route matching for SCHEDULED rides
const https = require('https');

let testCount = 0;
let successfulSearches = 0;
let matchesFound = 0;
let failedSearches = 0;

// Configuration
const CONFIG = {
  baseUrl: 'shareway-backend-cbvn.onrender.com',
  port: 443,
  searchInterval: 30000, // 30 seconds
  timeout: 15000,
  maxTests: 100,
  testDuration: 3600000,
};

// EXACT DRIVER ROUTE COORDINATES - FROM YOUR DRIVER DATA
const DRIVER_ROUTE = {
  pickupLocation: { lat: 9.5912196, lng: 41.9797191 }, // Dire Dawa
  destinationLocation: { lat: 11.6, lng: 37.3833 }, // Bahir Dar
  pickupName: "Dire Dawa",
  destinationName: "Bahir Dar",
  routePoints: [
    { lat: 9.5912196, lng: 41.9797191 },
    { lat: 9.596713, lng: 41.980184 },
    { lat: 9.596705, lng: 41.980639 },
    { lat: 9.458291, lng: 40.994234 },
    { lat: 8.984281, lng: 38.828945 },
    { lat: 9.720439, lng: 38.823141 },
    { lat: 10.230556, lng: 38.130382 },
    { lat: 11.599019, lng: 37.382776 }
  ],
  // Calculated values from your driver data
  distance: 968.9352879081407,
  duration: 2326, // minutes
  fare: 4405.208795586634,
  scheduledTime: "2025-11-30T00:00:00.000Z"
};

// KNOWN DRIVER ID FROM YOUR DATA
const TARGET_DRIVER_ID = "mtlB1Bd79RYtijBSR9wuyZHaI122";

function generateScheduledPassenger() {
  const timestamp = Date.now();
  const randomId = Math.random().toString(36).substring(2, 8);
  
  // Use the EXACT same scheduled time as driver
  const scheduledTime = new Date(DRIVER_ROUTE.scheduledTime);
  
  return {
    // User identification - MATCHING DRIVER'S FORMAT
    userId: "scheduled_passenger_" + timestamp + '_' + randomId,
    userType: "passenger",
    rideType: "scheduled", // CRITICAL: Must be "scheduled" not "immediate"
    
    // Passenger details
    passengerId: "scheduled_passenger_" + timestamp + '_' + randomId,
    passengerName: "Scheduled Test Passenger - Dire Dawa to Bahir Dar",
    passengerPhone: "+251911223344",
    passengerPhotoUrl: "https://example.com/avatars/passenger.jpg",
    
    // EXACT SAME LOCATION DATA AS DRIVER
    pickupLocation: {
      lat: DRIVER_ROUTE.pickupLocation.lat,
      lng: DRIVER_ROUTE.pickupLocation.lng,
      address: DRIVER_ROUTE.pickupName
    },
    destinationLocation: {
      lat: DRIVER_ROUTE.destinationLocation.lat,
      lng: DRIVER_ROUTE.destinationLocation.lng,
      address: DRIVER_ROUTE.destinationName
    },
    pickupName: DRIVER_ROUTE.pickupName,
    destinationName: DRIVER_ROUTE.destinationName,
    
    // EXACT SAME ROUTE POINTS AS DRIVER
    routePoints: DRIVER_ROUTE.routePoints,
    
    // EXACT SAME SCHEDULED TIME AS DRIVER
    scheduledTime: DRIVER_ROUTE.scheduledTime,
    
    // Passenger details - MATCHING DRIVER'S CAPACITY
    passengerCount: 1,
    currentPassengers: 0,
    capacity: 4,
    
    // EXACT SAME FARE/DISTANCE AS DRIVER
    distance: DRIVER_ROUTE.distance,
    duration: DRIVER_ROUTE.duration,
    fare: DRIVER_ROUTE.fare,
    
    // Preferences matching driver's capabilities
    estimatedFare: DRIVER_ROUTE.fare,
    specialRequests: "Testing SCHEDULED route matching - Dire Dawa to Bahir Dar",
    preferredVehicleType: "car",
    maxWaitTime: 60, // Longer wait for scheduled rides
    maxWalkDistance: 0.5,
    
    // Additional fields for better matching
    luggageCount: 1,
    paymentMethod: "cash",
    rating: "4.5",
    
    // Enhanced matching parameters
    matchPreferences: {
      minRating: 4.0,
      maxDetour: 20.0, // Higher for long distance scheduled rides
      vehicleTypes: ["car", "sedan"],
      allowFemaleDriver: true,
      allowMaleDriver: true
    }
  };
}

async function sendScheduledPassengerSearch(passengerData) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(passengerData);
    
    const options = {
      hostname: CONFIG.baseUrl,
      port: CONFIG.port,
      path: '/api/match/search',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'ShareWay-Scheduled-Passenger-Test/1.0'
      },
      timeout: CONFIG.timeout
    };

    const scheduledTime = new Date(passengerData.scheduledTime);
    const timeUntilRide = Math.round((scheduledTime - new Date()) / (1000 * 60)); // minutes
    
    console.log(`👤 Sending SCHEDULED PASSENGER search:`);
    console.log(`   📅 Route: ${passengerData.pickupName} → ${passengerData.destinationName}`);
    console.log(`   ⏰ Scheduled: ${passengerData.scheduledTime}`);
    console.log(`   ⏳ Time until ride: ${timeUntilRide} minutes`);
    
    const req = https.request(options, (res) => {
      let responseData = '';
      let statusCode = res.statusCode;

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        try {
          const result = JSON.parse(responseData);
          resolve({
            statusCode: statusCode,
            data: result,
            passenger: passengerData,
            headers: res.headers
          });
        } catch (e) {
          resolve({
            statusCode: statusCode,
            data: { raw: responseData, parseError: e.message },
            passenger: passengerData,
            headers: res.headers
          });
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timeout after ${CONFIG.timeout}ms`));
    });

    req.write(data);
    req.end();
  });
}

function displayResult(result, testCount) {
  const passenger = result.passenger;
  const response = result.data;
  
  const scheduledTime = new Date(passenger.scheduledTime);
  const timeUntilRide = Math.round((scheduledTime - new Date()) / (1000 * 60)); // minutes
  
  console.log(`\n📊 SCHEDULED PASSENGER TEST #${testCount}`);
  console.log('─────────────────────────────────────────────────────────');
  console.log(`👤 Passenger: ${passenger.passengerName}`);
  console.log(`📍 From: ${passenger.pickupName}`);
  console.log(`🎯 To: ${passenger.destinationName}`);
  console.log(`📅 Scheduled: ${passenger.scheduledTime}`);
  console.log(`⏳ Time until ride: ${timeUntilRide} minutes`);
  console.log(`💰 Fare: ETB ${passenger.fare}`);
  console.log(`📏 Distance: ${passenger.distance}km | ⏱️ ${passenger.duration}min`);
  console.log(`👥 Passengers: ${passenger.passengerCount}/${passenger.capacity}`);
  console.log(`🎯 Target Driver: ${TARGET_DRIVER_ID}`);
  console.log(`🎯 🚨 EXACT SCHEDULED DRIVER ROUTE - Should match!`);
  
  if (result.statusCode === 200) {
    if (response.success) {
      successfulSearches++;
      
      if (response.totalMatches > 0) {
        matchesFound += response.totalMatches;
        console.log(`✅ 🎉 SUCCESS! Found ${response.totalMatches} driver matches!`);
        
        // Check if our target driver is in the matches
        let targetDriverFound = false;
        if (response.matches && response.matches.length > 0) {
          console.log('\n📋 Matching Drivers:');
          response.matches.forEach((match, index) => {
            const isTargetDriver = match.driverId === TARGET_DRIVER_ID;
            if (isTargetDriver) targetDriverFound = true;
            
            console.log(`   ${index + 1}. ${match.driverName || 'Unknown Driver'} ${isTargetDriver ? '🎯 TARGET!' : ''}`);
            console.log(`      🆔 ${match.driverId || 'Unknown ID'}`);
            console.log(`      🚗 ${match.vehicleInfo?.model || 'Car'} | ⭐ ${match.matchScore || (match.similarity * 100).toFixed(1)}% match`);
            console.log(`      💰 ETB ${match.proposedFare} | 📏 ${match.distance?.toFixed(1) || '?'}km away`);
            console.log(`      🕒 Scheduled: ${match.scheduledTime || 'Not specified'}`);
            console.log(`      🪑 Seats: ${match.hasSeats ? 'Yes' : 'No'} | Similarity: ${(match.similarity * 100).toFixed(1)}%`);
          });
        }
        
        if (targetDriverFound) {
          console.log('\n🎉 SUCCESS! Target scheduled driver matched successfully!');
          console.log('🚗 SCHEDULED DRIVER FOUND! Check your app for notifications!');
        } else {
          console.log('\n⚠️  Matches found but target driver not in results');
          console.log('   Check if driver scheduled search is properly stored');
        }
        
      } else {
        console.log(`✅ Search successful but no driver matches found`);
        console.log(`   🔍 Checking scheduled driver: ${TARGET_DRIVER_ID}`);
        console.log(`   📅 Driver scheduled for: ${DRIVER_ROUTE.scheduledTime}`);
        console.log(`   📍 Driver route: ${DRIVER_ROUTE.pickupName} → ${DRIVER_ROUTE.destinationName}`);
        
        // Check if this is because scheduled search hasn't activated yet
        if (timeUntilRide > 30) { // More than 30 minutes until ride
          console.log(`   💡 Scheduled search activates 30 minutes before ride time`);
          console.log(`   ⏳ Current time until activation: ${timeUntilRide - 30} minutes`);
        }
        
        // Additional debug info
        if (response.debug) {
          console.log(`   🔧 Debug: ${JSON.stringify(response.debug)}`);
        }
      }
      
    } else {
      failedSearches++;
      console.log(`❌ API returned success: false`);
      if (response.error) {
        console.log(`   Error: ${response.error}`);
      }
      if (response.details) {
        console.log(`   Details: ${JSON.stringify(response.details)}`);
      }
    }
  } else {
    failedSearches++;
    console.log(`❌ HTTP Error: Status ${result.statusCode}`);
    if (response && response.message) {
      console.log(`   Message: ${response.message}`);
    }
  }
  
  // Display summary
  console.log('─────────────────────────────────────────────────────────');
  const successRate = testCount > 0 ? ((successfulSearches / testCount) * 100).toFixed(1) : 0;
  console.log(`📈 SUMMARY: ${successfulSearches}/${testCount} successful (${successRate}%) | ${matchesFound} total matches`);
  console.log(`⏰ Next scheduled passenger search in ${CONFIG.searchInterval / 1000} seconds...`);
  console.log('🛑 Press Ctrl+C to stop\n');
}

async function runContinuousTest() {
  console.log('=======================================================');
  console.log('👤 SHAREWAY SCHEDULED PASSENGER SEARCH TEST');
  console.log('=======================================================');
  console.log(`📍 Target: ${CONFIG.baseUrl}`);
  console.log(`⏰ Interval: ${CONFIG.searchInterval / 1000} seconds`);
  console.log(`📅 Route: ${DRIVER_ROUTE.pickupName} → ${DRIVER_ROUTE.destinationName}`);
  console.log(`🎯 Scheduled: ${DRIVER_ROUTE.scheduledTime}`);
  console.log(`📏 Distance: ${DRIVER_ROUTE.distance}km`);
  console.log(`💰 Fare: ETB ${DRIVER_ROUTE.fare}`);
  console.log(`🎯 Target Driver ID: ${TARGET_DRIVER_ID}`);
  console.log(`👥 Driver Capacity: 4 passengers`);
  console.log('🛑 Press Ctrl+C to stop the test');
  console.log('=======================================================\n');
  
  // Calculate time until activation
  const scheduledTime = new Date(DRIVER_ROUTE.scheduledTime);
  const activationTime = new Date(scheduledTime.getTime() - (30 * 60 * 1000)); // 30 minutes before
  const now = new Date();
  const timeUntilActivation = Math.round((activationTime - now) / (1000 * 60)); // minutes
  
  console.log(`⏰ SCHEDULE INFO:`);
  console.log(`   📅 Ride scheduled: ${DRIVER_ROUTE.scheduledTime}`);
  console.log(`   🔔 Search activates: ${activationTime.toISOString()}`);
  console.log(`   ⏳ Time until activation: ${timeUntilActivation} minutes`);
  console.log(`   💡 Matching will work when activation time is reached\n`);
  
  // Test server connectivity first
  await testServerConnectivity();
  
  // Initial delay to ensure driver scheduled search is stored
  console.log('⏳ Waiting 5 seconds for scheduled searches to be processed...');
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  const startTime = Date.now();
  let intervalId;

  // Run tests with interval
  const runTestCycle = async () => {
    if (testCount >= CONFIG.maxTests) {
      console.log('\n✅ Reached maximum test count. Stopping...');
      clearInterval(intervalId);
      displayFinalResults(startTime);
      return;
    }

    if (Date.now() - startTime > CONFIG.testDuration) {
      console.log('\n✅ Reached maximum test duration. Stopping...');
      clearInterval(intervalId);
      displayFinalResults(startTime);
      return;
    }

    await runSingleTest();
  };

  // Run first test immediately
  await runTestCycle();
  
  // Then run on interval
  intervalId = setInterval(runTestCycle, CONFIG.searchInterval);
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\n🛑 TEST STOPPED BY USER');
    clearInterval(intervalId);
    displayFinalResults(startTime);
    process.exit(0);
  });
}

async function testServerConnectivity() {
  console.log('🔍 Testing server connectivity...');
  
  try {
    const options = {
      hostname: CONFIG.baseUrl,
      port: CONFIG.port,
      path: '/health',
      method: 'GET',
      timeout: 10000
    };

    await new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.status === 'healthy' || res.statusCode === 200) {
              console.log('✅ Server is healthy and responsive');
              resolve();
            } else {
              reject(new Error('Server not healthy'));
            }
          } catch (e) {
            // If we can't parse but got 200, server is up
            if (res.statusCode === 200) {
              console.log('✅ Server is responsive (non-JSON response)');
              resolve();
            } else {
              reject(new Error('Invalid response from server'));
            }
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => reject(new Error('Connectivity test timeout')));
      req.end();
    });
  } catch (error) {
    console.log('❌ Server connectivity test failed:', error.message);
    console.log('💡 Continuing anyway - server might be up but health endpoint down');
  }
}

async function runSingleTest() {
  testCount++;
  
  try {
    const passengerData = generateScheduledPassenger();
    const result = await sendScheduledPassengerSearch(passengerData);
    displayResult(result, testCount);
  } catch (error) {
    failedSearches++;
    console.log(`\n📊 SCHEDULED PASSENGER TEST #${testCount}`);
    console.log('─────────────────────────────────────────────────────────');
    console.log(`❌ Request failed: ${error.message}`);
    console.log('─────────────────────────────────────────────────────────');
    const successRate = testCount > 0 ? ((successfulSearches / testCount) * 100).toFixed(1) : 0;
    console.log(`📈 SUMMARY: ${successfulSearches}/${testCount} successful (${successRate}%) | ${matchesFound} total matches`);
    console.log(`⏰ Next scheduled passenger search in ${CONFIG.searchInterval / 1000} seconds...\n`);
  }
}

function displayFinalResults(startTime) {
  const duration = Math.round((Date.now() - startTime) / 1000);
  const successRate = testCount > 0 ? ((successfulSearches / testCount) * 100).toFixed(1) : 0;
  
  console.log('=======================================================');
  console.log('📊 SCHEDULED PASSENGER TEST FINAL RESULTS');
  console.log('=======================================================');
  console.log(`⏱️  Test duration: ${Math.floor(duration / 60)}m ${duration % 60}s`);
  console.log(`🔢 Total tests run: ${testCount}`);
  console.log(`✅ Successful searches: ${successfulSearches}`);
  console.log(`❌ Failed searches: ${failedSearches}`);
  console.log(`📈 Success rate: ${successRate}%`);
  console.log(`🎯 Total driver matches found: ${matchesFound}`);
  console.log(`🎯 Target Driver ID: ${TARGET_DRIVER_ID}`);
  console.log(`📅 Scheduled Route: ${DRIVER_ROUTE.pickupName} → ${DRIVER_ROUTE.destinationName}`);
  console.log(`⏰ Scheduled Time: ${DRIVER_ROUTE.scheduledTime}`);
  console.log('=======================================================');
  
  if (matchesFound > 0) {
    console.log('\n🎉 SUCCESS! Scheduled route matching is working!');
    console.log('💡 Check if target driver appears in match results');
  } else {
    const scheduledTime = new Date(DRIVER_ROUTE.scheduledTime);
    const activationTime = new Date(scheduledTime.getTime() - (30 * 60 * 1000));
    const now = new Date();
    const timeUntilActivation = Math.round((activationTime - now) / (1000 * 60));
    
    console.log('\n💡 TROUBLESHOOTING SCHEDULED SEARCHES:');
    console.log(`   1. ✅ Both passenger and driver are using SCHEDULED search type`);
    console.log(`   2. 📅 Both have EXACT same scheduled time: ${DRIVER_ROUTE.scheduledTime}`);
    console.log(`   3. 🔔 Scheduled searches activate 30 minutes before ride time`);
    console.log(`   4. ⏳ Time until activation: ${timeUntilActivation} minutes`);
    console.log(`   5. 📍 Verify route points match exactly: ${DRIVER_ROUTE.pickupName} → ${DRIVER_ROUTE.destinationName}`);
    console.log(`   6. 🪑 Driver has capacity: 4 passengers`);
    console.log(`   7. 🔍 Check Firestore for scheduled_search collection`);
  }
}

// Start the continuous test
runContinuousTest().catch(error => {
  console.error('💥 Scheduled passenger test script crashed:', error);
  process.exit(1);
});
