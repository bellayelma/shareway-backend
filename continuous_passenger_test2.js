// continuous_passenger_test.js - EXACT driver route matching
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
  pickupLocation: { lat: 8.55, lng: 39.2667 },
  destinationLocation: { lat: 9.5892, lng: 41.8664 }, // Dire Dawa
  pickupName: "Adama",
  destinationName: "Dire Dawa",
  routePoints: [
    { lat: 8.549995, lng: 39.266714 },
    { lat: 8.549951, lng: 39.266697 },
    { lat: 8.913591, lng: 39.906468 },
    { lat: 9.28897, lng: 40.829771 },
    { lat: 9.52893, lng: 41.213885 },
    { lat: 9.547991, lng: 41.481037 },
    { lat: 9.589549, lng: 41.866169 }
  ],
  // Calculated approximate values for Adama → Dire Dawa
  distance: 320, // approx km
  duration: 360, // approx minutes
  fare: 800      // approx ETB
};

// KNOWN DRIVER ID FROM YOUR DATA
const TARGET_DRIVER_ID = "mtlB1Bd79RYtijBSR9wuyZHaI122";

function generatePassenger() {
  const timestamp = Date.now();
  const randomId = Math.random().toString(36).substring(2, 8);
  
  return {
    // User identification - MATCHING DRIVER'S FORMAT
    userId: "passenger_" + timestamp + '_' + randomId,
    userType: "passenger",
    rideType: "immediate",
    
    // Passenger details
    passengerId: "passenger_" + timestamp + '_' + randomId,
    passengerName: "Test Passenger - Adama to Dire Dawa", // Updated destination
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
    
    // Passenger details - MATCHING DRIVER'S CAPACITY
    passengerCount: 1, // Same as driver's passengerCount
    currentPassengers: 0,
    capacity: 4, // Same as driver's capacity
    
    // APPROXIMATE DISTANCE/FARE FOR THIS ROUTE
    distance: DRIVER_ROUTE.distance,
    duration: DRIVER_ROUTE.duration,
    fare: DRIVER_ROUTE.fare,
    
    // Preferences matching driver's capabilities
    estimatedFare: DRIVER_ROUTE.fare,
    specialRequests: "Testing exact route matching - Adama to Dire Dawa",
    preferredVehicleType: "car",
    maxWaitTime: 60, // Longer wait for long distance
    maxWalkDistance: 0.5,
    
    // Additional fields for better matching
    luggageCount: 1,
    paymentMethod: "cash",
    rating: "4.5",
    
    // Enhanced matching parameters
    matchPreferences: {
      minRating: 4.0,
      maxDetour: 10.0, // Higher for long distance
      vehicleTypes: ["car", "sedan"],
      allowFemaleDriver: true,
      allowMaleDriver: true
    }
  };
}

async function sendPassengerSearch(passengerData) {
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
        'User-Agent': 'ShareWay-Passenger-Test/1.0'
      },
      timeout: CONFIG.timeout
    };

    console.log(`👤 Sending PASSENGER search for route: ${passengerData.pickupName} → ${passengerData.destinationName}`);
    
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
  
  console.log(`\n📊 PASSENGER TEST #${testCount}`);
  console.log('─────────────────────────────────────────────────────────');
  console.log(`👤 Passenger: ${passenger.passengerName}`);
  console.log(`📍 From: ${passenger.pickupName}`);
  console.log(`🎯 To: ${passenger.destinationName}`);
  console.log(`💰 Fare: ETB ${passenger.fare}`);
  console.log(`📏 Distance: ${passenger.distance}km | ⏱️ ${passenger.duration}min`);
  console.log(`👥 Passengers: ${passenger.passengerCount}/${passenger.capacity}`);
  console.log(`🎯 Target Driver: ${TARGET_DRIVER_ID}`);
  console.log(`🎯 🚨 EXACT DRIVER ROUTE - Should match immediately!`);
  
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
            console.log(`      🪑 Seats: ${match.hasSeats ? 'Yes' : 'No'} | Similarity: ${(match.similarity * 100).toFixed(1)}%`);
          });
        }
        
        if (targetDriverFound) {
          console.log('\n🎉 SUCCESS! Target driver matched successfully!');
          console.log('🚗 DRIVER FOUND! Check your app for notifications!');
        } else {
          console.log('\n⚠️  Matches found but target driver not in results');
          console.log('   Check if driver search is active with correct route');
        }
        
      } else {
        console.log(`✅ Search successful but no driver matches found`);
        console.log(`   🔍 Checking driver: ${TARGET_DRIVER_ID}`);
        console.log(`   💡 Ensure driver is actively searching with same route`);
        console.log(`   📍 Driver route: Adama → Dire Dawa`);
        
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
  console.log(`⏰ Next passenger search in ${CONFIG.searchInterval / 1000} seconds...`);
  console.log('🛑 Press Ctrl+C to stop\n');
}

async function runContinuousTest() {
  console.log('=======================================================');
  console.log('👤 SHAREWAY PASSENGER SEARCH TEST - EXACT DRIVER ROUTE');
  console.log('=======================================================');
  console.log(`📍 Target: ${CONFIG.baseUrl}`);
  console.log(`⏰ Interval: ${CONFIG.searchInterval / 1000} seconds`);
  console.log(`🎯 Route: ${DRIVER_ROUTE.pickupName} → ${DRIVER_ROUTE.destinationName}`);
  console.log(`📏 Distance: ${DRIVER_ROUTE.distance}km (approx)`);
  console.log(`💰 Fare: ETB ${DRIVER_ROUTE.fare} (approx)`);
  console.log(`🎯 Target Driver ID: ${TARGET_DRIVER_ID}`);
  console.log(`👥 Driver Capacity: 4 passengers`);
  console.log('🛑 Press Ctrl+C to stop the test');
  console.log('=======================================================\n');
  
  // Test server connectivity first
  await testServerConnectivity();
  
  // Initial delay to ensure driver is ready
  console.log('⏳ Waiting 5 seconds for driver to be ready...');
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
    const passengerData = generatePassenger();
    const result = await sendPassengerSearch(passengerData);
    displayResult(result, testCount);
  } catch (error) {
    failedSearches++;
    console.log(`\n📊 PASSENGER TEST #${testCount}`);
    console.log('─────────────────────────────────────────────────────────');
    console.log(`❌ Request failed: ${error.message}`);
    console.log('─────────────────────────────────────────────────────────');
    const successRate = testCount > 0 ? ((successfulSearches / testCount) * 100).toFixed(1) : 0;
    console.log(`📈 SUMMARY: ${successfulSearches}/${testCount} successful (${successRate}%) | ${matchesFound} total matches`);
    console.log(`⏰ Next passenger search in ${CONFIG.searchInterval / 1000} seconds...\n`);
  }
}

function displayFinalResults(startTime) {
  const duration = Math.round((Date.now() - startTime) / 1000);
  const successRate = testCount > 0 ? ((successfulSearches / testCount) * 100).toFixed(1) : 0;
  
  console.log('=======================================================');
  console.log('📊 PASSENGER TEST FINAL RESULTS');
  console.log('=======================================================');
  console.log(`⏱️  Test duration: ${Math.floor(duration / 60)}m ${duration % 60}s`);
  console.log(`🔢 Total tests run: ${testCount}`);
  console.log(`✅ Successful searches: ${successfulSearches}`);
  console.log(`❌ Failed searches: ${failedSearches}`);
  console.log(`📈 Success rate: ${successRate}%`);
  console.log(`🎯 Total driver matches found: ${matchesFound}`);
  console.log(`🎯 Target Driver ID: ${TARGET_DRIVER_ID}`);
  console.log(`📍 Route: Adama → Dire Dawa`);
  console.log('=======================================================');
  
  if (matchesFound > 0) {
    console.log('\n🎉 SUCCESS! Route matching is working!');
    console.log('💡 Check if target driver appears in match results');
  } else {
    console.log('\n💡 TROUBLESHOOTING:');
    console.log('   1. ✅ Both passenger and driver are using the EXACT same route: Adama → Dire Dawa');
    console.log('   2. 🔍 Check if driver search is still active in Firestore');
    console.log('   3. 📍 Verify route points match exactly');
    console.log('   4. 🪑 Driver has capacity: 4 passengers');
    console.log('   5. ⏰ Ensure both are searching simultaneously');
  }
}

// Start the continuous test
runContinuousTest().catch(error => {
  console.error('💥 Passenger test script crashed:', error);
  process.exit(1);
});
