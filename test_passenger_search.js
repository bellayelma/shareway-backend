// test_passenger_search.js - Single passenger search test
const https = require('https');

const PASSENGER_DATA = {
  userId: "passenger_bole_to_adama_001",
  userType: "passenger",
  rideType: "immediate", // Change to "scheduled" for scheduled ride
  pickupLocation: { 
    lat: 9.033,  // Bole area coordinates
    lng: 38.760
  },
  destinationLocation: { 
    lat: 8.546,  // Adama area coordinates
    lng: 39.268
  },
  passengerCount: 4,
  maxWalkDistance: 0.5,
  // For scheduled ride - uncomment below:
  // scheduledTime: "2024-11-30T12:00:00.000Z",
  preferences: {
    vehicleType: "any",
    acceptFemaleDrivers: true,
    acceptMaleDrivers: true
  }
};

// For scheduled ride test, uncomment this version:
const SCHEDULED_PASSENGER_DATA = {
  userId: "passenger_scheduled_bole_adama_001",
  userType: "passenger", 
  rideType: "scheduled",
  pickupLocation: { 
    lat: 9.033,  // Bole
    lng: 38.760
  },
  destinationLocation: { 
    lat: 8.546,  // Adama
    lng: 39.268
  },
  passengerCount: 4,
  maxWalkDistance: 0.5,
  scheduledTime: "2024-11-30T12:00:00.000Z", // Nov 30, 12:00 PM
  preferences: {
    vehicleType: "any",
    acceptFemaleDrivers: true,
    acceptMaleDrivers: true
  }
};

function sendPassengerSearch(passengerData) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(passengerData);
    
    const options = {
      hostname: 'shareway-backend-cbvn.onrender.com',
      port: 443,
      path: '/match/search',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };

    console.log('🚀 Sending passenger search request...');
    console.log('📍 Pickup: Bole (9.033, 38.760)');
    console.log('🎯 Destination: Adama (8.546, 39.268)');
    console.log('👥 Passengers: 4');
    console.log('⏰ Ride Type:', passengerData.rideType);
    if (passengerData.scheduledTime) {
      console.log('📅 Scheduled: Nov 30, 12:00 PM');
    }

    const req = https.request(options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        console.log('\n✅ Response received!');
        console.log('📊 Status Code:', res.statusCode);
        
        try {
          const result = JSON.parse(responseData);
          console.log('🎯 Server Response:', JSON.stringify(result, null, 2));
          
          if (result.success) {
            console.log('\n🎉 PASSENGER SEARCH SUCCESSFUL!');
            console.log('🔍 Search ID:', result.searchId);
            console.log('🚗 Matches Found:', result.matchesFound);
            console.log('📍 Route Hash:', result.routeHash);
          } else {
            console.log('\n❌ Search failed:', result.error);
          }
        } catch (e) {
          console.log('📨 Raw response:', responseData);
        }
        
        resolve(responseData);
      });
    });

    req.on('error', (error) => {
      console.error('\n❌ Request failed:', error);
      reject(error);
    });

    req.write(data);
    req.end();
  });
}

// Main execution
async function main() {
  console.log('=====================================');
  console.log('🚗 SHAREWAY PASSENGER SEARCH TEST');
  console.log('=====================================\n');
  
  // Choose which test to run:
  const testImmediate = true; // Set to false to test scheduled ride
  
  const passengerData = testImmediate ? PASSENGER_DATA : SCHEDULED_PASSENGER_DATA;
  
  try {
    await sendPassengerSearch(passengerData);
  } catch (error) {
    console.error('Test failed:', error);
  }
}

// Run the script
main();
