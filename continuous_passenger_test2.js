// continuous_driver_test.js - Enhanced for driver search testing
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

const DRIVER_TEMPLATES = [
  // Bole to Adama routes
  {
    userId: "driver_bole_adama_",
    driverName: "John Driver",
    driverPhone: "+251911223344",
    pickupLocation: { lat: 9.033, lng: 38.760, address: "Bole International Airport" },
    destinationLocation: { lat: 8.546, lng: 39.268, address: "Adama City Center" },
    pickupName: "Bole International Airport",
    destinationName: "Adama City Center",
    capacity: 4,
    vehicleInfo: {
      model: "Toyota Corolla",
      plate: "3-ABC-123",
      color: "White",
      year: "2022",
      ac: true
    }
  },
  {
    userId: "driver_bole2_adama_",
    driverName: "Michael Driver", 
    driverPhone: "+251922334455",
    pickupLocation: { lat: 9.028, lng: 38.755, address: "Bole Medhanialem" },
    destinationLocation: { lat: 8.542, lng: 39.272, address: "Adama University" },
    pickupName: "Bole Medhanialem",
    destinationName: "Adama University",
    capacity: 6,
    vehicleInfo: {
      model: "Toyota Hiace",
      plate: "3-DEF-456",
      color: "Blue",
      year: "2020",
      ac: true
    }
  },
  {
    userId: "driver_bole3_adama_",
    driverName: "David Driver",
    driverPhone: "+251933445566",
    pickupLocation: { lat: 9.038, lng: 38.765, address: "Bole Arabsa" },
    destinationLocation: { lat: 8.550, lng: 39.260, address: "Adama Stadium" },
    pickupName: "Bole Arabsa", 
    destinationName: "Adama Stadium",
    capacity: 4,
    vehicleInfo: {
      model: "Honda Civic",
      plate: "3-GHI-789",
      color: "Black",
      year: "2021",
      ac: true
    }
  },
  // Addis Ababa city routes
  {
    userId: "driver_merkato_4kilo_",
    driverName: "Alex Driver",
    driverPhone: "+251944556677",
    pickupLocation: { lat: 9.020, lng: 38.740, address: "Merkato Main Gate" },
    destinationLocation: { lat: 9.030, lng: 38.770, address: "4 Kilo Campus" },
    pickupName: "Merkato Main Gate",
    destinationName: "4 Kilo Campus",
    capacity: 4,
    vehicleInfo: {
      model: "Hyundai Accent",
      plate: "3-JKL-012",
      color: "Silver",
      year: "2019",
      ac: false
    }
  },
  {
    userId: "driver_mexico_piazza_",
    driverName: "Robert Driver", 
    driverPhone: "+251955667788",
    pickupLocation: { lat: 9.010, lng: 38.750, address: "Mexico Square" },
    destinationLocation: { lat: 9.050, lng: 38.780, address: "Piazza Post Office" },
    pickupName: "Mexico Square",
    destinationName: "Piazza Post Office", 
    capacity: 4,
    vehicleInfo: {
      model: "Toyota Yaris",
      plate: "3-MNO-345",
      color: "Red",
      year: "2023",
      ac: true
    }
  },
  {
    userId: "driver_sar_bet_ghion_",
    driverName: "Daniel Driver",
    driverPhone: "+251966778899",
    pickupLocation: { lat: 9.025, lng: 38.760, address: "Sar Bet" },
    destinationLocation: { lat: 9.040, lng: 38.775, address: "Ghion Hotel" },
    pickupName: "Sar Bet",
    destinationName: "Ghion Hotel",
    capacity: 7,
    vehicleInfo: {
      model: "Toyota Hiace",
      plate: "3-PQR-678",
      color: "White",
      year: "2020",
      ac: true
    }
  }
];

function generateRandomDriver() {
  const template = DRIVER_TEMPLATES[Math.floor(Math.random() * DRIVER_TEMPLATES.length)];
  const timestamp = Date.now();
  const randomId = Math.random().toString(36).substring(2, 8);
  const isScheduled = Math.random() > 0.7; // 30% scheduled rides
  
  // Generate route points for better matching
  const routePoints = generateRoutePoints(template.pickupLocation, template.destinationLocation);
  
  return {
    // User identification - CRITICAL FIELDS
    userId: template.userId + timestamp + '_' + randomId,
    userType: "driver", // THIS IS WHAT YOUR FLUTTER APP WAS MISSING!
    rideType: isScheduled ? "scheduled" : "immediate",
    
    // Driver details - MUST MATCH YOUR FLUTTER APP
    driverId: template.userId + timestamp + '_' + randomId,
    driverName: template.driverName,
    driverPhone: template.driverPhone,
    driverPhotoUrl: "https://example.com/avatars/driver.jpg",
    
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
    
    // Vehicle & capacity
    capacity: template.capacity,
    currentPassengers: Math.floor(Math.random() * 2), // 0-1 current passengers
    vehicleInfo: template.vehicleInfo,
    
    // Route information
    routePoints: routePoints,
    distance: calculateRouteDistance(routePoints),
    duration: Math.floor(calculateRouteDistance(routePoints) * 3 + 10),
    fare: Math.floor(calculateRouteDistance(routePoints) * 15 + 50),
    
    // Scheduling
    scheduledTime: isScheduled ? 
      new Date(Date.now() + Math.floor(Math.random() * 24 * 60 * 60 * 1000)).toISOString() : 
      undefined,
    
    // Preferences
    estimatedFare: Math.floor(calculateRouteDistance(routePoints) * 15 + 50),
    specialRequests: Math.random() > 0.8 ? "No pets please" : "",
    preferredVehicleType: "car",
    maxWaitTime: 15 + Math.floor(Math.random() * 30),
    maxWalkDistance: 0.5
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
  return Math.round(distance * 10) / 10;
}

function calculateDistance(point1, point2) {
  const R = 6371;
  const dLat = (point2.lat - point1.lat) * Math.PI / 180;
  const dLng = (point2.lng - point1.lng) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(point1.lat * Math.PI / 180) * Math.cos(point2.lat * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

async function sendDriverSearch(driverData) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(driverData);
    
    const options = {
      hostname: CONFIG.baseUrl,
      port: CONFIG.port,
      path: '/api/match/search',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'ShareWay-Driver-Test/1.0'
      },
      timeout: CONFIG.timeout
    };

    console.log(`🚗 Sending DRIVER search request to: ${CONFIG.baseUrl}${options.path}`);
    
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
            driver: driverData,
            headers: res.headers
          });
        } catch (e) {
          resolve({
            statusCode: statusCode,
            data: { raw: responseData, parseError: e.message },
            driver: driverData,
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
  const driver = result.driver;
  const response = result.data;
  
  console.log(`\n📊 DRIVER TEST #${testCount}`);
  console.log('─────────────────────────────────────────────────────────');
  console.log(`👤 Driver: ${driver.driverName}`);
  console.log(`📞 Phone: ${driver.driverPhone}`);
  console.log(`📍 From: ${driver.pickupName}`);
  console.log(`🎯 To: ${driver.destinationName}`);
  console.log(`🚗 Vehicle: ${driver.vehicleInfo.model} (${driver.vehicleInfo.color})`);
  console.log(`👥 Capacity: ${driver.capacity} seats | Available: ${driver.capacity - driver.currentPassengers}`);
  console.log(`📏 Distance: ${driver.distance}km | ⏱️ ${driver.duration}min`);
  console.log(`💰 Estimated fare: ETB ${driver.estimatedFare}`);
  console.log(`🔍 Type: ${driver.rideType.toUpperCase()} ride`);
  
  if (result.statusCode === 200) {
    if (response.success) {
      successfulSearches++;
      
      if (response.totalMatches > 0) {
        matchesFound += response.totalMatches;
        console.log(`✅ 🎉 SUCCESS! Found ${response.totalMatches} passenger matches!`);
        console.log('🚶 PASSENGERS FOUND! Check your app for notifications!');
        
        if (response.matches && response.matches.length > 0) {
          console.log('\n📋 Matching Passengers:');
          response.matches.forEach((match, index) => {
            console.log(`   ${index + 1}. ${match.passengerName || 'Passenger'} (${match.passengerPhone || 'No phone'})`);
            console.log(`      👥 ${match.passengerCount || 1} passengers | ⭐ ${match.matchScore || match.similarity * 100}% match`);
            console.log(`      💰 ETB ${match.proposedFare} | 📏 ${match.distance?.toFixed(1) || '?'}km`);
          });
        }
      } else {
        console.log(`✅ Search successful but no passenger matches found`);
        console.log(`   💡 Make sure passengers are actively searching in the system`);
        console.log(`   🔍 Try running the passenger test script simultaneously`);
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
  console.log(`⏰ Next driver search in ${CONFIG.searchInterval / 1000} seconds...`);
  console.log('🛑 Press Ctrl+C to stop\n');
}

async function runContinuousTest() {
  console.log('=======================================================');
  console.log('🚗 SHAREWAY CONTINUOUS DRIVER SEARCH TEST');
  console.log('=======================================================');
  console.log(`📍 Target: ${CONFIG.baseUrl}`);
  console.log(`⏰ Interval: ${CONFIG.searchInterval / 1000} seconds`);
  console.log(`⏱️ Timeout: ${CONFIG.timeout / 1000} seconds`);
  console.log(`🔢 Max tests: ${CONFIG.maxTests}`);
  console.log(`🚗 Testing: Driver search functionality`);
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
    const driverData = generateRandomDriver();
    const result = await sendDriverSearch(driverData);
    displayResult(result, testCount);
  } catch (error) {
    failedSearches++;
    console.log(`\n📊 DRIVER TEST #${testCount}`);
    console.log('─────────────────────────────────────────────────────────');
    console.log(`❌ Request failed: ${error.message}`);
    console.log('─────────────────────────────────────────────────────────');
    const successRate = ((successfulSearches / testCount) * 100).toFixed(1);
    console.log(`📈 SUMMARY: ${successfulSearches}/${testCount} successful (${successRate}%) | ${matchesFound} total matches`);
    console.log(`⏰ Next driver search in ${CONFIG.searchInterval / 1000} seconds...\n`);
  }
}

function displayFinalResults(startTime) {
  const duration = Math.round((Date.now() - startTime) / 1000);
  const successRate = testCount > 0 ? ((successfulSearches / testCount) * 100).toFixed(1) : 0;
  
  console.log('=======================================================');
  console.log('📊 DRIVER TEST FINAL RESULTS');
  console.log('=======================================================');
  console.log(`⏱️  Test duration: ${Math.floor(duration / 60)}m ${duration % 60}s`);
  console.log(`🔢 Total tests run: ${testCount}`);
  console.log(`✅ Successful searches: ${successfulSearches}`);
  console.log(`❌ Failed searches: ${failedSearches}`);
  console.log(`📈 Success rate: ${successRate}%`);
  console.log(`🎯 Total passenger matches found: ${matchesFound}`);
  console.log(`📊 Average matches per test: ${testCount > 0 ? (matchesFound / testCount).toFixed(2) : 0}`);
  console.log('=======================================================');
  
  // Recommendations based on results
  if (matchesFound === 0) {
    console.log('\n💡 RECOMMENDATIONS:');
    console.log('   - Run passenger test script simultaneously to create matches');
    console.log('   - Check if passenger routes overlap with driver routes');
    console.log('   - Verify the matching algorithm is working correctly');
    console.log('   - Check Firestore for active passenger searches');
    console.log('   - Ensure driver data includes userType: "driver"');
  } else {
    console.log('\n🎉 SUCCESS! Driver search is working correctly!');
    console.log('   Your Flutter app should now be able to find passengers');
  }
}

// Start the continuous test
runContinuousTest().catch(error => {
  console.error('💥 Driver test script crashed:', error);
  process.exit(1);
});
