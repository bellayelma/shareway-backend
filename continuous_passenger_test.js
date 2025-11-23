// continuous_passenger_test.js - Enhanced for new backend structure
const https = require('https');

let testCount = 0;
let successfulSearches = 0;
let matchesFound = 0;
let failedSearches = 0;

// Configuration
const CONFIG = {
  baseUrl: 'shareway-backend-cbvn.onrender.com', // Your Render.com URL
  port: 443,
  searchInterval: 30000, // 30 seconds
  timeout: 15000, // 15 seconds
  maxTests: 100, // Maximum number of tests to run
  testDuration: 3600000, // 1 hour maximum test duration
};

const PASSENGER_TEMPLATES = [
  // Bole to Adama routes
  {
    userId: "passenger_bole_adama_",
    passengerName: "Alex Bole",
    passengerPhone: "+251911223344",
    pickupLocation: { lat: 9.033, lng: 38.760, address: "Bole International Airport" },
    destinationLocation: { lat: 8.546, lng: 39.268, address: "Adama City Center" },
    pickupName: "Bole International Airport",
    destinationName: "Adama City Center",
    passengerCount: 4,
    maxWalkDistance: 1.5
  },
  {
    userId: "passenger_bole2_adama_",
    passengerName: "Sarah Bole",
    passengerPhone: "+251922334455", 
    pickupLocation: { lat: 9.028, lng: 38.755, address: "Bole Medhanialem" },
    destinationLocation: { lat: 8.542, lng: 39.272, address: "Adama University" },
    pickupName: "Bole Medhanialem",
    destinationName: "Adama University",
    passengerCount: 2,
    maxWalkDistance: 1.0
  },
  {
    userId: "passenger_bole3_adama_",
    passengerName: "Mike Bole",
    passengerPhone: "+251933445566",
    pickupLocation: { lat: 9.038, lng: 38.765, address: "Bole Arabsa" },
    destinationLocation: { lat: 8.550, lng: 39.260, address: "Adama Stadium" },
    pickupName: "Bole Arabsa", 
    destinationName: "Adama Stadium",
    passengerCount: 3,
    maxWalkDistance: 2.0
  },
  // Addis Ababa city routes
  {
    userId: "passenger_merkato_4kilo_",
    passengerName: "John Merkato",
    passengerPhone: "+251944556677",
    pickupLocation: { lat: 9.020, lng: 38.740, address: "Merkato Main Gate" },
    destinationLocation: { lat: 9.030, lng: 38.770, address: "4 Kilo Campus" },
    pickupName: "Merkato Main Gate",
    destinationName: "4 Kilo Campus",
    passengerCount: 1,
    maxWalkDistance: 0.5
  },
  {
    userId: "passenger_mexico_piazza_",
    passengerName: "Lisa Mexico", 
    passengerPhone: "+251955667788",
    pickupLocation: { lat: 9.010, lng: 38.750, address: "Mexico Square" },
    destinationLocation: { lat: 9.050, lng: 38.780, address: "Piazza Post Office" },
    pickupName: "Mexico Square",
    destinationName: "Piazza Post Office", 
    passengerCount: 2,
    maxWalkDistance: 1.2
  },
  {
    userId: "passenger_sar_bet_ghion_",
    passengerName: "Daniel Sar Bet",
    passengerPhone: "+251966778899",
    pickupLocation: { lat: 9.025, lng: 38.760, address: "Sar Bet" },
    destinationLocation: { lat: 9.040, lng: 38.775, address: "Ghion Hotel" },
    pickupName: "Sar Bet",
    destinationName: "Ghion Hotel",
    passengerCount: 1,
    maxWalkDistance: 0.8
  }
];

function generateRandomPassenger() {
  const template = PASSENGER_TEMPLATES[Math.floor(Math.random() * PASSENGER_TEMPLATES.length)];
  const timestamp = Date.now();
  const randomId = Math.random().toString(36).substring(2, 8);
  const isScheduled = Math.random() > 0.7; // 30% scheduled rides
  
  // Generate route points for better matching
  const routePoints = generateRoutePoints(template.pickupLocation, template.destinationLocation);
  
  return {
    // User identification
    userId: template.userId + timestamp + '_' + randomId,
    userType: "passenger",
    rideType: isScheduled ? "scheduled" : "immediate",
    
    // Passenger details
    passengerId: template.userId + timestamp + '_' + randomId,
    passengerName: template.passengerName,
    passengerPhone: template.passengerPhone,
    passengerPhotoUrl: "https://example.com/avatars/passenger.jpg",
    
    // Location data
    pickupLocation: {
      lat: template.pickupLocation.lat + (Math.random() - 0.5) * 0.005,
      lng: template.pickupLocation.lng + (Math.random() - 0.5) * 0.005,
      address: template.pickupLocation.address
    },
    destinationLocation: {
      lat: template.destinationLocation.lat + (Math.random() - 0.5) * 0.005,
      lng: template.destinationLocation.lng + (Math.random() - 0.5) * 0.005,
      address: template.destinationLocation.address
    },
    pickupName: template.pickupName,
    destinationName: template.destinationName,
    
    // Trip details
    passengerCount: template.passengerCount,
    maxWalkDistance: template.maxWalkDistance,
    
    // Route information
    routePoints: routePoints,
    distance: calculateRouteDistance(routePoints),
    duration: Math.floor(calculateRouteDistance(routePoints) * 3 + 10), // Rough estimate
    fare: Math.floor(calculateRouteDistance(routePoints) * 15 + 50), // Rough estimate
    
    // Scheduling
    scheduledTime: isScheduled ? 
      new Date(Date.now() + Math.floor(Math.random() * 24 * 60 * 60 * 1000)).toISOString() : 
      undefined,
    
    // Preferences
    estimatedFare: Math.floor(calculateRouteDistance(routePoints) * 15 + 50),
    specialRequests: Math.random() > 0.8 ? "No smoking please" : "",
    preferredVehicleType: ["car", "suv", "van"][Math.floor(Math.random() * 3)],
    maxWaitTime: 15 + Math.floor(Math.random() * 30)
  };
}

function generateRoutePoints(start, end, numPoints = 5) {
  const points = [start];
  
  for (let i = 1; i < numPoints - 1; i++) {
    const ratio = i / (numPoints - 1);
    points.push({
      lat: start.lat + (end.lat - start.lat) * ratio + (Math.random() - 0.5) * 0.002,
      lng: start.lng + (end.lng - start.lng) * ratio + (Math.random() - 0.5) * 0.002
    });
  }
  
  points.push(end);
  return points;
}

function calculateRouteDistance(routePoints) {
  let distance = 0;
  for (let i = 0; i < routePoints.length - 1; i++) {
    distance += calculateDistance(routePoints[i], routePoints[i + 1]);
  }
  return Math.round(distance * 10) / 10; // Round to 1 decimal
}

function calculateDistance(point1, point2) {
  const R = 6371; // Earth's radius in km
  const dLat = (point2.lat - point1.lat) * Math.PI / 180;
  const dLng = (point2.lng - point1.lng) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(point1.lat * Math.PI / 180) * Math.cos(point2.lat * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
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
        'User-Agent': 'ShareWay-Test-Script/1.0'
      },
      timeout: CONFIG.timeout
    };

    console.log(`🔍 Sending search request to: ${CONFIG.baseUrl}${options.path}`);
    
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
  
  console.log(`\n📊 TEST #${testCount}`);
  console.log('─────────────────────────────────────────────────────────');
  console.log(`👤 Passenger: ${passenger.passengerName}`);
  console.log(`📞 Phone: ${passenger.passengerPhone}`);
  console.log(`📍 From: ${passenger.pickupName}`);
  console.log(`🎯 To: ${passenger.destinationName}`);
  console.log(`📏 Distance: ${passenger.distance}km | ⏱️ ${passenger.duration}min`);
  console.log(`👥 ${passenger.passengerCount} passengers | ${passenger.rideType.toUpperCase()} ride`);
  console.log(`💰 Estimated fare: ETB ${passenger.estimatedFare}`);
  
  if (result.statusCode === 200) {
    if (response.success) {
      successfulSearches++;
      
      if (response.totalMatches > 0) {
        matchesFound += response.totalMatches;
        console.log(`✅ 🎉 SUCCESS! Found ${response.totalMatches} matches!`);
        console.log('🚗 DRIVERS FOUND! Check your driver app for notifications!');
        
        if (response.matches && response.matches.length > 0) {
          console.log('\n📋 Matching Drivers:');
          response.matches.forEach((match, index) => {
            console.log(`   ${index + 1}. ${match.driverName || 'Driver'} (${match.driverPhone || 'No phone'})`);
            console.log(`      🚙 ${match.vehicleInfo?.model || 'Vehicle'} | ⭐ ${match.matchScore || match.similarity * 100}% match`);
            console.log(`      💰 ETB ${match.proposedFare} | 📏 ${match.distance?.toFixed(1) || '?'}km`);
          });
        }
      } else {
        console.log(`✅ Search successful but no matches found`);
        console.log(`   💡 Make sure drivers are active and searching in the system`);
      }
      
      if (response.searchId) {
        console.log(`   🔍 Search ID: ${response.searchId}`);
      }
      
    } else {
      failedSearches++;
      console.log(`❌ API returned success: false`);
      if (response.error) {
        console.log(`   Error: ${response.error}`);
      }
      if (response.details) {
        console.log(`   Details: ${response.details}`);
      }
    }
  } else {
    failedSearches++;
    console.log(`❌ HTTP Error: Status ${result.statusCode}`);
    if (response.error) {
      console.log(`   Error: ${response.error}`);
    }
    if (response.message) {
      console.log(`   Message: ${response.message}`);
    }
  }
  
  // Display summary
  console.log('─────────────────────────────────────────────────────────');
  const successRate = ((successfulSearches / testCount) * 100).toFixed(1);
  console.log(`📈 SUMMARY: ${successfulSearches}/${testCount} successful (${successRate}%) | ${matchesFound} total matches`);
  console.log(`⏰ Next search in ${CONFIG.searchInterval / 1000} seconds...`);
  console.log('🛑 Press Ctrl+C to stop\n');
}

async function runContinuousTest() {
  console.log('=======================================================');
  console.log('🚗 SHAREWAY ENHANCED CONTINUOUS PASSENGER SEARCH TEST');
  console.log('=======================================================');
  console.log(`📍 Target: ${CONFIG.baseUrl}`);
  console.log(`⏰ Interval: ${CONFIG.searchInterval / 1000} seconds`);
  console.log(`⏱️ Timeout: ${CONFIG.timeout / 1000} seconds`);
  console.log(`🔢 Max tests: ${CONFIG.maxTests}`);
  console.log('🛑 Press Ctrl+C to stop the test');
  console.log('=======================================================\n');
  
  // Test server connectivity first
  await testServerConnectivity();
  
  // Initial delay
  await new Promise(resolve => setTimeout(resolve, 2000));
  
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
            if (result.status === 'healthy') {
              console.log('✅ Server is healthy and responsive');
              resolve();
            } else {
              reject(new Error('Server not healthy'));
            }
          } catch (e) {
            reject(new Error('Invalid response from server'));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => reject(new Error('Connectivity test timeout')));
      req.end();
    });
  } catch (error) {
    console.log('❌ Server connectivity test failed:', error.message);
    console.log('💡 Please check:');
    console.log('   - Is the server running?');
    console.log('   - Is the URL correct?');
    console.log('   - Are there any firewall restrictions?');
    process.exit(1);
  }
}

async function runSingleTest() {
  testCount++;
  
  try {
    const passengerData = generateRandomPassenger();
    const result = await sendPassengerSearch(passengerData);
    displayResult(result, testCount);
  } catch (error) {
    failedSearches++;
    console.log(`\n📊 TEST #${testCount}`);
    console.log('─────────────────────────────────────────────────────────');
    console.log(`❌ Request failed: ${error.message}`);
    console.log('─────────────────────────────────────────────────────────');
    const successRate = ((successfulSearches / testCount) * 100).toFixed(1);
    console.log(`📈 SUMMARY: ${successfulSearches}/${testCount} successful (${successRate}%) | ${matchesFound} total matches`);
    console.log(`⏰ Next search in ${CONFIG.searchInterval / 1000} seconds...\n`);
  }
}

function displayFinalResults(startTime) {
  const duration = Math.round((Date.now() - startTime) / 1000);
  const successRate = testCount > 0 ? ((successfulSearches / testCount) * 100).toFixed(1) : 0;
  
  console.log('=======================================================');
  console.log('📊 FINAL TEST RESULTS');
  console.log('=======================================================');
  console.log(`⏱️  Test duration: ${Math.floor(duration / 60)}m ${duration % 60}s`);
  console.log(`🔢 Total tests run: ${testCount}`);
  console.log(`✅ Successful searches: ${successfulSearches}`);
  console.log(`❌ Failed searches: ${failedSearches}`);
  console.log(`📈 Success rate: ${successRate}%`);
  console.log(`🎯 Total matches found: ${matchesFound}`);
  console.log(`📊 Average matches per test: ${testCount > 0 ? (matchesFound / testCount).toFixed(2) : 0}`);
  console.log('=======================================================');
  
  // Recommendations based on results
  if (matchesFound === 0) {
    console.log('\n💡 RECOMMENDATIONS:');
    console.log('   - Ensure drivers are actively searching in the system');
    console.log('   - Check if driver routes overlap with test passenger routes');
    console.log('   - Verify the matching algorithm is working correctly');
    console.log('   - Check Firestore for active driver searches');
  }
}

// Start the continuous test
runContinuousTest().catch(error => {
  console.error('💥 Test script crashed:', error);
  process.exit(1);
});
