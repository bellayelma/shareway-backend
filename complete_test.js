// complete_test.js - Add drivers first, then test passenger search
const https = require('https');

const RENDER_BACKEND = 'shareway-backend-cbvn.onrender.com';

// Test driver data
const TEST_DRIVERS = [
  {
    userId: "driver_001",
    userType: "driver",
    rideType: "immediate",
    currentLocation: { lat: 9.030, lng: 38.758 }, // Near Bole pickup
    destinationLocation: { lat: 8.550, lng: 39.270 }, // Near Adama destination
    availableSeats: 4,
    vehicleType: "sedan",
    status: "available",
    rating: 4.8,
    routeHash: "9.030,38.758_8.550,39.270"
  },
  {
    userId: "driver_002", 
    userType: "driver",
    rideType: "immediate",
    currentLocation: { lat: 9.035, lng: 38.762 }, // Very close to Bole pickup
    destinationLocation: { lat: 8.545, lng: 39.265 }, // Very close to Adama destination
    availableSeats: 6,
    vehicleType: "suv",
    status: "available",
    rating: 4.9,
    routeHash: "9.035,38.762_8.545,39.265"
  }
];

// Passenger data
const PASSENGER_DATA = {
  userId: "passenger_bole_adama_001",
  userType: "passenger",
  rideType: "immediate",
  pickupLocation: { lat: 9.033, lng: 38.760 }, // Bole
  destinationLocation: { lat: 8.546, lng: 39.268 }, // Adama
  passengerCount: 4,
  maxWalkDistance: 2.0, // Increased to 2km for better matching
  preferences: {
    vehicleType: "any",
    acceptFemaleDrivers: true,
    acceptMaleDrivers: true
  }
};

function makeRequest(endpoint, data) {
  return new Promise((resolve, reject) => {
    const jsonData = JSON.stringify(data);
    
    const options = {
      hostname: RENDER_BACKEND,
      port: 443,
      path: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': jsonData.length
      }
    };

    const req = https.request(options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        try {
          const result = JSON.parse(responseData);
          resolve({
            statusCode: res.statusCode,
            data: result
          });
        } catch (e) {
          resolve({
            statusCode: res.statusCode,
            data: responseData
          });
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(jsonData);
    req.end();
  });
}

async function addTestDrivers() {
  console.log('🚗 Adding test drivers...');
  
  for (const driver of TEST_DRIVERS) {
    try {
      const result = await makeRequest('/match/search', driver);
      
      if (result.statusCode === 200 && result.data.success) {
        console.log(`✅ Driver ${driver.userId} added successfully`);
        console.log(`   📍 Location: ${driver.currentLocation.lat},${driver.currentLocation.lng}`);
        console.log(`   🎯 Destination: ${driver.destinationLocation.lat},${driver.destinationLocation.lng}`);
        console.log(`   👥 Seats: ${driver.availableSeats}`);
      } else {
        console.log(`❌ Failed to add driver ${driver.userId}:`, result.data);
      }
    } catch (error) {
      console.log(`❌ Error adding driver ${driver.userId}:`, error.message);
    }
    
    // Wait 1 second between requests
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

async function testPassengerSearch() {
  console.log('\n🚀 Testing passenger search...');
  console.log('📍 Pickup: Bole (9.033, 38.760)');
  console.log('🎯 Destination: Adama (8.546, 39.268)');
  console.log('👥 Passengers: 4');
  console.log('⏰ Ride Type: immediate\n');

  try {
    const result = await makeRequest('/match/search', PASSENGER_DATA);
    
    console.log('✅ Response received!');
    console.log('📊 Status Code:', result.statusCode);
    console.log('🎯 Server Response:', JSON.stringify(result.data, null, 2));
    
    if (result.data.success) {
      console.log('\n🎉 PASSENGER SEARCH SUCCESSFUL!');
      if (result.data.matchesFound > 0) {
        console.log(`🚗 Matches Found: ${result.data.matchesFound}`);
        if (result.data.matches) {
          console.log('\n📋 Matching Drivers:');
          result.data.matches.forEach((match, index) => {
            console.log(`   ${index + 1}. ${match.driverId} - ${match.distanceToPickup?.toFixed(2)}km away`);
          });
        }
      } else {
        console.log('❌ No matches found - drivers may not be close enough');
      }
    } else {
      console.log('❌ Search failed:', result.data.error);
    }
    
  } catch (error) {
    console.log('❌ Request failed:', error.message);
  }
}

async function cleanupTestData() {
  console.log('\n🧹 Cleaning up test data...');
  
  // Note: You'll need to implement cleanup in your backend
  // This would typically involve deleting the test documents
  const cleanupIds = [
    ...TEST_DRIVERS.map(d => d.userId),
    PASSENGER_DATA.userId
  ];
  
  console.log('📝 Test IDs to clean up:', cleanupIds);
  console.log('💡 Implement cleanup in your backend as needed');
}

// Main execution
async function main() {
  console.log('=====================================');
  console.log('🚗 SHAREWAY COMPLETE MATCHING TEST');
  console.log('=====================================\n');
  
  // Step 1: Add test drivers
  await addTestDrivers();
  
  // Wait a bit for drivers to be processed
  console.log('\n⏳ Waiting for drivers to be processed...');
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Step 2: Test passenger search
  await testPassengerSearch();
  
  // Step 3: Cleanup (optional)
  // await cleanupTestData();
  
  console.log('\n=====================================');
  console.log('🎉 TEST COMPLETED');
  console.log('=====================================');
}

// Run the script
main().catch(console.error);
