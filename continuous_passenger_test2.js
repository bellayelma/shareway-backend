// adugna_passenger_simple.js - Single search for Adugna Belay
const https = require('https');

// Configuration
const CONFIG = {
  baseUrl: 'shareway-backend-cbvn.onrender.com',
  port: 443,
  timeout: 15000,
};

function createPassenger() {
  const timestamp = Date.now();
  const randomId = Math.floor(Math.random() * 10000);
  
  return {
    userId: "passenger_adugna_" + timestamp + '_' + randomId,
    userType: 'passenger',
    passengerName: "Adugna Belay",
    passengerPhone: "+251911223344",
    passengerPhotoUrl: "https://cdn-icons-png.flaticon.com/512/1946/1946429.png",
    passengerRating: 4.8,
    totalRides: 15,
    isVerified: true,
    
    // 🎯 PICKUP LOCATION
    pickupLocation: {
      lat: 8.549995,
      lng: 39.266714
    },
    
    // 🎯 DESTINATION
    destinationLocation: {
      lat: 9.589549,
      lng: 41.866169
    },
    
    pickupName: "Adama",
    destinationName: "Dire Dawa",
    
    // Route points - using exact driver route
    routePoints: [
      { lat: 8.549995, lng: 39.266714 },
      { lat: 8.549951, lng: 39.266697 },
      { lat: 8.913591, lng: 39.906468 },
      { lat: 9.28897, lng: 40.829771 },
      { lat: 9.52893, lng: 41.213885 },
      { lat: 9.547991, lng: 41.481037 },
      { lat: 9.589549, lng: 41.866169 }
    ],
    
    // Additional data
    passengerCount: 2,
    maxWaitTime: 30,
    preferredVehicleType: "car",
    specialRequests: "Window seat preferred",
    maxWalkDistance: 0.5,
    distance: 320,
    duration: 360,
    estimatedFare: 800,
    
    rideType: "immediate",
    searchId: "adugna_search_" + timestamp
  };
}

async function makeRequest(options, data = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        try {
          const jsonResponse = JSON.parse(responseData);
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data: jsonResponse
          });
        } catch (error) {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data: responseData
          });
        }
      });
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    req.setTimeout(CONFIG.timeout, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    if (data) {
      req.write(JSON.stringify(data));
    }
    
    req.end();
  });
}

async function healthCheck() {
  try {
    const options = {
      hostname: CONFIG.baseUrl,
      port: CONFIG.port,
      path: '/api/health',
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    };
    
    const response = await makeRequest(options);
    
    if (response.statusCode === 200 && response.data.success) {
      console.log('✅ Server is healthy');
      console.log('   Message: ' + response.data.message);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Health check failed: ' + error.message);
    return false;
  }
}

async function sendPassengerSearch() {
  try {
    const passengerData = createPassenger();
    
    console.log('\n' + '='.repeat(60));
    console.log('🚕 SHAREWAY - ADAMA TO DIRE DAWA');
    console.log('👤 Passenger: Adugna Belay');
    console.log('='.repeat(60));
    
    console.log('\n📝 Passenger Details:');
    console.log('-'.repeat(40));
    console.log(`Name: ${passengerData.passengerName}`);
    console.log(`Photo: ${passengerData.passengerPhotoUrl}`);
    console.log(`Pickup: ${passengerData.pickupName} (${passengerData.pickupLocation.lat.toFixed(6)}, ${passengerData.pickupLocation.lng.toFixed(6)})`);
    console.log(`Destination: ${passengerData.destinationName} (${passengerData.destinationLocation.lat.toFixed(6)}, ${passengerData.destinationLocation.lng.toFixed(6)})`);
    console.log(`Route Points: ${passengerData.routePoints.length} waypoints`);
    console.log(`Passengers: ${passengerData.passengerCount}`);
    console.log(`Fare: ETB ${passengerData.estimatedFare}`);
    console.log('-'.repeat(40));
    
    const options = {
      hostname: CONFIG.baseUrl,
      port: CONFIG.port,
      path: '/api/match/search',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };
    
    console.log('\n⏳ Sending search request to backend...');
    
    const response = await makeRequest(options, passengerData);
    
    console.log('\n' + '='.repeat(60));
    console.log('🚕 SEARCH RESULTS');
    console.log('='.repeat(60));
    
    if (response.statusCode === 200 && response.data.success) {
      console.log('✅ Search started successfully!');
      console.log(`🔍 Search ID: ${response.data.searchId}`);
      
      if (response.data.totalMatches > 0) {
        console.log(`\n🎉 Found ${response.data.totalMatches} available drivers!`);
        
        if (response.data.matches && response.data.matches.length > 0) {
          console.log('\n📋 Available Drivers:');
          console.log('-'.repeat(50));
          
          response.data.matches.forEach((match, index) => {
            console.log(`\n${index + 1}. ${match.driver?.name || 'Driver'}`);
            console.log(`   🚗 ${match.driver?.vehicleInfo?.model || 'Car'}`);
            console.log(`   ⭐ Similarity: ${match.driver?.similarityScore || 'N/A'}`);
            console.log(`   💰 Fare: ETB ${match.proposedFare || passengerData.estimatedFare}`);
            console.log(`   📍 Distance: ${match.distanceToPickup?.toFixed(1) || '?'}km`);
          });
        }
      } else {
        console.log('\n⚠️  No drivers available at the moment');
        console.log('   The system will continue searching...');
      }
      
    } else {
      console.log('❌ Search failed');
      console.log(`   Status: ${response.statusCode}`);
      console.log(`   Error: ${response.data?.error || 'Unknown error'}`);
      
      // Show more details for debugging
      if (response.data) {
        console.log(`   Response: ${JSON.stringify(response.data)}`);
      }
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('🛑 Search request completed.');
    console.log('='.repeat(60));
    
  } catch (error) {
    console.log('\n❌ Error: ' + error.message);
    console.log('💡 Make sure the backend server is running');
  }
}

async function runSearch() {
  console.log('🔍 Checking server connectivity...');
  
  const healthy = await healthCheck();
  if (!healthy) {
    console.log('⚠️  Server might not be available, but trying anyway...');
  }
  
  await sendPassengerSearch();
  
  // Wait a bit before exiting
  setTimeout(() => {
    console.log('\n✅ Script completed. Exiting...');
    process.exit(0);
  }, 3000);
}

// Handle Ctrl+C
process.on('SIGINT', () => {
  console.log('\n\n🛑 Exiting...');
  process.exit(0);
});

// Run the search
runSearch().catch(error => {
  console.error('💥 Script error:', error);
  process.exit(1);
});
