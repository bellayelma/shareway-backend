// continuous_passenger_search_local_fixed.js - Continuous search for 5 different passengers WITH DISTINCT LOCATIONS
const http = require('http');

// ✅ CONFIGURATION FOR LOCAL SERVER
const CONFIG = {
  hostname: 'localhost',
  port: 3000,
  timeout: 15000,
  useHTTPS: false,
  searchInterval: 5000, // Time between passenger searches (5 seconds)
  totalPassengers: 5,   // Number of different passengers
};

// Define Ethiopian passenger names and details
const PASSENGER_PROFILES = [
  {
    id: 1,
    fullName: "Adugna Belay",
    phone: "+251911233344",  // ✅ Use phone number as userId
    rating: 4.8,
    totalRides: 15,
    photo: "https://cdn-icons-png.flaticon.com/512/1946/1946429.png",
    preferences: {
      preferredVehicleType: "car",
      specialRequests: "Window seat preferred"
    },
    seatsNeeded: 1  // ✅ Fixed: Always needs 1 seat
  },
  {
    id: 2,
    fullName: "Selamawit Mekonnen",
    phone: "+251922434455",  // ✅ Use phone number as userId
    rating: 4.9,
    totalRides: 32,
    photo: "https://cdn-icons-png.flaticon.com/512/4323/4323004.png",
    preferences: {
      preferredVehicleType: "car",
      specialRequests: "Quiet ride"
    },
    seatsNeeded: 1  // ✅ Fixed: Always needs 1 seat
  },
  {
    id: 3,
    fullName: "Tewodros Haile",
    phone: "+251933445596",  // ✅ Use phone number as userId
    rating: 4.5,
    totalRides: 8,
    photo: "https://cdn-icons-png.flaticon.com/512/3135/3135715.png",
    preferences: {
      preferredVehicleType: "car",
      specialRequests: "Air conditioning"
    },
    seatsNeeded: 1  // ✅ Fixed: Always needs 1 seat
  },
  {
    id: 4,
    fullName: "Mihret Abebe",
    phone: "+251944556977",  // ✅ Use phone number as userId
    rating: 4.7,
    totalRides: 21,
    photo: "https://cdn-icons-png.flaticon.com/512/6997/6997662.png",
    preferences: {
      preferredVehicleType: "car",
      specialRequests: "Extra legroom"
    },
    seatsNeeded: 1  // ✅ Fixed: Always needs 1 seat
  },
  {
    id: 5,
    fullName: "Daniel Girma",
    phone: "+251956667788",  // ✅ Use phone number as userId
    rating: 4.6,
    totalRides: 12,
    photo: "https://cdn-icons-png.flaticon.com/512/3011/3011270.png",
    preferences: {
      preferredVehicleType: "car",
      specialRequests: "Traveling with a friend"
    },
    seatsNeeded: 2  // ✅ Fixed: Always needs 2 seats
  }
];

// Main route from Adama to Dire Dawa (same for all passengers)
const MAIN_ROUTE = {
  pickup: {
    name: "Adama",
    lat: 8.549995,
    lng: 39.266714
  },
  dropoff: {
    name: "Dire Dawa",
    lat: 9.589549,
    lng: 41.866169
  },
  routePoints: [
    { lat: 8.549995, lng: 39.266714 },
    { lat: 8.549951, lng: 39.266697 },
    { lat: 8.913591, lng: 39.906468 },
    { lat: 9.28897, lng: 40.829771 },
    { lat: 9.52893, lng: 41.213885 },
    { lat: 9.547991, lng: 41.481037 },
    { lat: 9.589549, lng: 41.866169 }
  ]
};

// ==================== FIXED: Generate DISTINCT locations for each passenger ====================
function generateNearbyLocation(baseLat, baseLng, passengerId) {
  // Create DISTINCT locations for each passenger (0.5-2km radius)
  const angle = (passengerId * 72) * (Math.PI / 180); // Each passenger at 72-degree intervals (360/5)
  
  // Different distances for each passenger (0.5km to 2km)
  const distanceInKm = 0.5 + (passengerId * 0.3); // Passenger 1: 0.8km, 2: 1.1km, 3: 1.4km, 4: 1.7km, 5: 2.0km
  
  // Convert km to degrees (approximately)
  // 1 degree latitude ≈ 111.32 km
  // 1 degree longitude ≈ 111.32 km * cos(latitude)
  const kmPerDegreeLat = 111.32;
  const kmPerDegreeLng = 111.32 * Math.cos(baseLat * Math.PI / 180);
  
  // Calculate offsets in degrees
  const latOffsetKm = distanceInKm * Math.cos(angle);
  const lngOffsetKm = distanceInKm * Math.sin(angle);
  
  const latOffsetDeg = latOffsetKm / kmPerDegreeLat;
  const lngOffsetDeg = lngOffsetKm / kmPerDegreeLng;
  
  const resultLat = baseLat + latOffsetDeg;
  const resultLng = baseLng + lngOffsetDeg;
  
  console.log(`📍 Passenger ${passengerId} unique location calculation:`);
  console.log(`   Base: ${baseLat.toFixed(6)}, ${baseLng.toFixed(6)}`);
  console.log(`   Angle: ${(angle * 180/Math.PI).toFixed(1)}°`);
  console.log(`   Distance: ${distanceInKm.toFixed(2)} km`);
  console.log(`   Lat offset: ${latOffsetDeg.toFixed(6)}° (${latOffsetKm.toFixed(2)} km)`);
  console.log(`   Lng offset: ${lngOffsetDeg.toFixed(6)}° (${lngOffsetKm.toFixed(2)} km)`);
  console.log(`   Result: ${resultLat.toFixed(6)}, ${resultLng.toFixed(6)}`);
  
  return {
    lat: resultLat,
    lng: resultLng
  };
}

// ==================== FIXED: Generate DISTINCT destination locations ====================
function generateDestinationLocation(baseLat, baseLng, passengerId) {
  // Create DISTINCT destination locations for each passenger
  const angle = ((passengerId * 50) + 30) * (Math.PI / 180); // Different angle pattern
  
  // Smaller offsets for destination (200-800 meters)
  const distanceInKm = 0.2 + (passengerId * 0.15); // Passenger 1: 0.35km, 2: 0.5km, etc.
  
  const kmPerDegreeLat = 111.32;
  const kmPerDegreeLng = 111.32 * Math.cos(baseLat * Math.PI / 180);
  
  const latOffsetKm = distanceInKm * Math.cos(angle);
  const lngOffsetKm = distanceInKm * Math.sin(angle);
  
  const latOffsetDeg = latOffsetKm / kmPerDegreeLat;
  const lngOffsetDeg = lngOffsetKm / kmPerDegreeLng;
  
  return {
    lat: baseLat + latOffsetDeg,
    lng: baseLng + lngOffsetDeg
  };
}

function createPassenger(passengerProfile, searchCount) {
  const timestamp = Date.now();
  const passengerId = passengerProfile.id;
  
  // Generate UNIQUE nearby locations for each passenger
  const pickupLocation = generateNearbyLocation(
    MAIN_ROUTE.pickup.lat, 
    MAIN_ROUTE.pickup.lng, 
    passengerId
  );
  
  const dropoffLocation = generateDestinationLocation(
    MAIN_ROUTE.dropoff.lat, 
    MAIN_ROUTE.dropoff.lng, 
    passengerId
  );
  
  // ✅ Use the fixed seat requirement from profile
  const numberOfSeats = passengerProfile.seatsNeeded;
  
  // Generate UNIQUE route points for each passenger
  const uniqueRoutePoints = MAIN_ROUTE.routePoints.map((point, index) => {
    // Add passenger-specific variations to each route point
    const passengerFactor = passengerId * 0.0001; // Small factor based on passenger ID
    const indexFactor = index * 0.00005; // Small factor based on point index
    
    return {
      lat: point.lat + (passengerFactor * Math.cos(index * 0.5)) + (Math.random() * 0.0005 - 0.00025),
      lng: point.lng + (passengerFactor * Math.sin(index * 0.5)) + (Math.random() * 0.0005 - 0.00025)
    };
  });
  
  return {
    // ✅ REQUIRED FIELDS - Use phone number as userId
    userId: passengerProfile.phone,  // ✅ Use phone number as userId
    userType: 'passenger',
    rideType: "immediate",
    searchNumber: searchCount,
    
    // ✅ PROFILE DATA
    passengerName: passengerProfile.fullName,
    passengerPhone: passengerProfile.phone,
    passengerPhotoUrl: passengerProfile.photo,
    passengerPhoto: passengerProfile.photo,
    
    // ✅ LOCATION DATA (each passenger has DISTINCT location)
    pickup: {
      address: `${MAIN_ROUTE.pickup.name} - Passenger ${passengerId} (${pickupLocation.lat.toFixed(6)}, ${pickupLocation.lng.toFixed(6)})`,
      location: pickupLocation
    },
    dropoff: {
      address: `${MAIN_ROUTE.dropoff.name} - Passenger ${passengerId} (${dropoffLocation.lat.toFixed(6)}, ${dropoffLocation.lng.toFixed(6)})`,
      location: dropoffLocation
    },
    
    // ✅ Additional location names
    pickupName: `${MAIN_ROUTE.pickup.name} - P${passengerId}`,
    destinationName: `${MAIN_ROUTE.dropoff.name} - P${passengerId}`,
    
    // ✅ PASSENGER COUNT - MODIFIED: Fixed seat requirements per profile
    numberOfPassengers: numberOfSeats,
    passengerCount: numberOfSeats, // Add passengerCount for matching service
    
    // ✅ Route points (DISTINCT for each passenger)
    routePoints: uniqueRoutePoints,
    
    // ✅ Store coordinates in the format matching service expects
    coordinates: {
      pickupLat: pickupLocation.lat,
      pickupLng: pickupLocation.lng,
      destLat: dropoffLocation.lat,
      destLng: dropoffLocation.lng
    },
    
    // ✅ Additional profile data
    passengerRating: passengerProfile.rating,
    totalRides: passengerProfile.totalRides,
    isVerified: Math.random() > 0.3, // 70% are verified
    
    // ✅ Ride preferences
    ridePreferences: {
      maxWaitTime: 15 + Math.floor(Math.random() * 30), // 15-45 minutes
      preferredVehicleType: passengerProfile.preferences.preferredVehicleType,
      specialRequests: passengerProfile.preferences.specialRequests,
      maxWalkDistance: 0.2 + (Math.random() * 0.8) // 0.2-1.0 km
    },
    
    // ✅ Route information (different for each passenger)
    distance: 320 + Math.floor(Math.random() * 20) - 10, // 310-330 km
    duration: 360 + Math.floor(Math.random() * 30) - 15, // 345-375 minutes
    estimatedFare: 800 + Math.floor(Math.random() * 100) - 50, // 750-850 ETB
    
    // ✅ Search metadata
    searchId: `passenger_${passengerId}_search_${timestamp}`,
    passengerProfileId: passengerId,
    
    // ✅ Current location (for location updates)
    currentLocation: {
      latitude: pickupLocation.lat,
      longitude: pickupLocation.lng,
      accuracy: 10 + Math.random() * 20,
      timestamp: timestamp
    },
    
    // ✅ Individual location fields (for direct access)
    pickupLocation: pickupLocation,
    destinationLocation: dropoffLocation
  };
}

async function makeRequest(options, data = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        try {
          if (responseData) {
            const jsonResponse = JSON.parse(responseData);
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              data: jsonResponse
            });
          } else {
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              data: {}
            });
          }
        } catch (error) {
          // If JSON parsing fails, return raw response
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data: responseData,
            raw: true
          });
        }
      });
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    req.setTimeout(CONFIG.timeout, () => {
      req.destroy();
      reject(new Error(`Request timeout after ${CONFIG.timeout}ms`));
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
      hostname: CONFIG.hostname,
      port: CONFIG.port,
      path: '/api/health',
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'ShareWay-Multi-Passenger-Test/1.0'
      }
    };
    
    console.log(`🔍 Checking server at http://${CONFIG.hostname}:${CONFIG.port}/api/health...`);
    
    const response = await makeRequest(options);
    
    // Accept any 200 response as healthy
    if (response.statusCode === 200) {
      console.log('✅ Server is responding!');
      
      // Try to parse and display the response
      if (response.raw) {
        console.log('   Response (raw):', response.data);
        return { healthy: true, data: { message: 'Server is running' } };
      } else {
        console.log('   Response:', JSON.stringify(response.data, null, 2));
        return { healthy: true, data: response.data };
      }
    } else {
      console.log(`❌ Server responded with status: ${response.statusCode}`);
      return { healthy: false, error: `Status ${response.statusCode}` };
    }
  } catch (error) {
    console.error('❌ Health check failed:', error.message);
    console.log('💡 Make sure your server is running: node app.js');
    console.log('   Or check if the port is correct: netstat -an | grep 3000');
    return { healthy: false, error: error.message };
  }
}

async function sendPassengerSearch(passengerProfile, searchCount) {
  try {
    const passengerData = createPassenger(passengerProfile, searchCount);
    
    const options = {
      hostname: CONFIG.hostname,
      port: CONFIG.port,
      path: '/api/match/search',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'ShareWay-Multi-Passenger-Test/1.0',
        'Origin': 'http://localhost:8082'
      }
    };
    
    console.log(`\n📤 Sending search for ${passengerData.passengerName}...`);
    console.log(`   URL: http://${CONFIG.hostname}:${CONFIG.port}${options.path}`);
    console.log(`   Passenger ID: ${passengerData.userId} (phone number)`);
    console.log(`   User Type: ${passengerData.userType}`);
    
    // ✅ DISPLAY DISTINCT LOCATION
    console.log(`   📍 UNIQUE PICKUP: ${passengerData.pickup.location.lat.toFixed(6)}, ${passengerData.pickup.location.lng.toFixed(6)}`);
    console.log(`   📍 UNIQUE DESTINATION: ${passengerData.dropoff.location.lat.toFixed(6)}, ${passengerData.dropoff.location.lng.toFixed(6)}`);
    
    // ✅ DISPLAY SEAT COUNT WITH APPROPRIATE MESSAGE
    if (passengerProfile.seatsNeeded === 1) {
      console.log(`   🪑 Seats needed: ${passengerData.numberOfPassengers} (solo traveler)`);
    } else if (passengerProfile.seatsNeeded === 2) {
      console.log(`   🪑 Seats needed: ${passengerData.numberOfPassengers} (traveling with a friend)`);
    }
    
    console.log(`   📊 Route points: ${passengerData.routePoints.length} unique points`);
    
    const response = await makeRequest(options, passengerData);
    
    return {
      success: response.statusCode === 200,
      passengerName: passengerData.passengerName,
      passengerId: passengerData.passengerProfileId,
      passengerPhone: passengerData.passengerPhone,
      userType: passengerData.userType,
      searchNumber: searchCount,
      statusCode: response.statusCode,
      data: response.data,
      rawResponse: response.raw ? response.data : null,
      location: {
        pickup: passengerData.pickup.location,
        dropoff: passengerData.dropoff.location
      },
      numberOfPassengers: passengerData.numberOfPassengers,
      seatsNeeded: passengerProfile.seatsNeeded,
      uniquePickup: passengerData.pickup.location, // Store unique location
      uniqueDropoff: passengerData.dropoff.location // Store unique destination
    };
  } catch (error) {
    console.error(`   ❌ Request error: ${error.message}`);
    return {
      success: false,
      passengerName: passengerProfile.fullName,
      passengerId: passengerProfile.id,
      passengerPhone: passengerProfile.phone,
      userType: 'passenger',
      error: error.message,
      searchNumber: searchCount
    };
  }
}

// ✅ FIXED: Correct location update endpoint
async function updatePassengerLocation(passengerPhone, passengerName, searchCount) {
  try {
    // Generate a slightly updated location (simulating movement while waiting)
    const passengerProfile = PASSENGER_PROFILES.find(p => p.phone === passengerPhone);
    const passengerId = passengerProfile?.id || 1;
    
    // Get base location from passenger's original pickup
    const basePickup = generateNearbyLocation(
      MAIN_ROUTE.pickup.lat,
      MAIN_ROUTE.pickup.lng,
      passengerId
    );
    
    // Calculate movement over time (searchCount represents time progression)
    const movement = searchCount * 0.00005; // Very small movement per search
    const angle = (passengerId * 60 + searchCount * 5) * (Math.PI / 180);
    
    const currentLat = basePickup.lat + Math.cos(angle) * movement;
    const currentLng = basePickup.lng + Math.sin(angle) * movement;
    
    const locationData = {
      userId: passengerPhone,  // ✅ Use phone number
      userType: 'passenger',
      latitude: currentLat,
      longitude: currentLng,
      accuracy: 10 + Math.random() * 15,
      speed: Math.random() * 5, // 0-5 km/h (waiting)
      heading: Math.random() * 360,
      timestamp: Date.now(),
      altitude: 1500 + Math.random() * 500, // Adama elevation ~1500m
      altitudeAccuracy: 10
    };
    
    // ✅ CORRECT ENDPOINT: /api/location/:userId/:userType/update
    const endpointPath = `/api/location/${encodeURIComponent(passengerPhone)}/passenger/update`;
    
    const options = {
      hostname: CONFIG.hostname,
      port: CONFIG.port,
      path: endpointPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };
    
    console.log(`   📍 Updating location for ${passengerName}...`);
    console.log(`   Endpoint: POST ${endpointPath}`);
    console.log(`   Phone: ${passengerPhone}`);
    console.log(`   New location: (${currentLat.toFixed(6)}, ${currentLng.toFixed(6)})`);
    
    const response = await makeRequest(options, locationData);
    
    return {
      success: response.statusCode === 200,
      passengerName: passengerName,
      passengerPhone: passengerPhone,
      userType: 'passenger',
      location: {
        lat: currentLat,
        lng: currentLng
      },
      data: response.data,
      searchNumber: searchCount
    };
  } catch (error) {
    console.error(`   ❌ Location update error: ${error.message}`);
    return {
      success: false,
      passengerName: passengerName,
      passengerPhone: passengerPhone,
      userType: 'passenger',
      error: error.message
    };
  }
}

// ✅ Test location sharing endpoints
async function testLocationSharing(passengerPhone, passengerName) {
  console.log(`\n🧪 Testing location sharing for ${passengerName}...`);
  
  // 1. Get location status
  try {
    const statusPath = `/api/location/${encodeURIComponent(passengerPhone)}/passenger/status`;
    const options = {
      hostname: CONFIG.hostname,
      port: CONFIG.port,
      path: statusPath,
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    };
    
    console.log(`   🔍 Getting location status...`);
    const response = await makeRequest(options);
    
    if (response.statusCode === 200) {
      console.log(`   ✅ Location status:`, response.data);
    } else {
      console.log(`   ❌ Status check failed: ${response.statusCode}`);
    }
  } catch (error) {
    console.log(`   ❌ Status check error: ${error.message}`);
  }
  
  // 2. Try to get other user's location (driver)
  try {
    const otherPath = `/api/location/${encodeURIComponent(passengerPhone)}/passenger/other`;
    const options = {
      hostname: CONFIG.hostname,
      port: CONFIG.port,
      path: otherPath,
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    };
    
    console.log(`   🔍 Getting driver's location...`);
    const response = await makeRequest(options);
    
    if (response.statusCode === 200) {
      console.log(`   ✅ Driver location:`, response.data);
    } else {
      console.log(`   ❌ Driver location check failed: ${response.statusCode}`);
    }
  } catch (error) {
    console.log(`   ❌ Driver location check error: ${error.message}`);
  }
}

function displaySearchResult(result, searchStats) {
  const timestamp = new Date().toLocaleTimeString();
  const passengerColor = result.passengerId === 1 ? '🟢' :
                        result.passengerId === 2 ? '🔵' :
                        result.passengerId === 3 ? '🟡' :
                        result.passengerId === 4 ? '🟣' :
                        '🔴'; // Red for the 5th passenger (2 seats)
  
  console.log(`\n${passengerColor} [${timestamp}] Passenger ${result.passengerId}: ${result.passengerName}`);
  console.log('─'.repeat(60));
  
  if (result.success) {
    console.log(`✅ Search #${result.searchNumber} successful!`);
    console.log(`   Status: ${result.statusCode}`);
    console.log(`   Phone: ${result.passengerPhone}`);
    console.log(`   User Type: ${result.userType}`);
    
    // ✅ DISPLAY UNIQUE LOCATION
    console.log(`   📍 UNIQUE PICKUP: (${result.location.pickup.lat.toFixed(6)}, ${result.location.pickup.lng.toFixed(6)})`);
    console.log(`   📍 UNIQUE DESTINATION: (${result.location.dropoff.lat.toFixed(6)}, ${result.location.dropoff.lng.toFixed(6)})`);
    
    // ✅ DISPLAY SEAT COUNT WITH APPROPRIATE MESSAGE
    if (result.seatsNeeded === 1) {
      console.log(`   🪑 Seats: ${result.numberOfPassengers || 'N/A'} (solo traveler)`);
    } else if (result.seatsNeeded === 2) {
      console.log(`   🪑 Seats: ${result.numberOfPassengers || 'N/A'} (traveling with friend)`);
    }
    
    // Try to display matches if available
    if (result.data && !result.rawResponse) {
      if (result.data.totalMatches !== undefined) {
        console.log(`   Matches found: ${result.data.totalMatches}`);
      } else if (result.data.matches && Array.isArray(result.data.matches)) {
        console.log(`   Matches found: ${result.data.matches.length}`);
      } else if (result.data.message) {
        console.log(`   Message: ${result.data.message}`);
      }
      
      if (result.data.websocketStatus) {
        console.log(`   WebSocket: ${result.data.websocketStatus.connected ? '✅ Connected' : '❌ Disconnected'}`);
      }
      
      if (result.data.passengerPhoto) {
        console.log(`   Photo URL: ${result.data.passengerPhoto.substring(0, 50)}...`);
      }
    } else if (result.rawResponse) {
      console.log(`   Raw response: ${result.rawResponse}`);
    }
    
    // Update statistics
    searchStats.successfulSearches++;
    if (result.data && !result.rawResponse) {
      if ((result.data.totalMatches > 0) || 
          (result.data.matches && result.data.matches.length > 0)) {
        searchStats.matchesFound++;
      }
    }
  } else {
    console.log(`❌ Search #${result.searchNumber} failed`);
    console.log(`   Error: ${result.error || `Status ${result.statusCode}`}`);
    if (result.data && result.data.error) {
      console.log(`   Server error: ${result.data.error}`);
    }
    searchStats.failedSearches++;
  }
  
  // Display current stats
  console.log(`📊 Stats: ${searchStats.successfulSearches}✅ ${searchStats.failedSearches}❌ ${searchStats.matchesFound}🎯`);
  console.log(`   Total searches: ${searchStats.totalSearches}`);
  
  return searchStats;
}

function displayLocationUpdateResult(result, locationStats) {
  if (result.success) {
    locationStats.successfulUpdates++;
    console.log(`   📍 Location updated: (${result.location.lat.toFixed(6)}, ${result.location.lng.toFixed(6)})`);
    if (result.data && result.data.message) {
      console.log(`   Message: ${result.data.message}`);
    }
  } else {
    locationStats.failedUpdates++;
    console.log(`   ❌ Location update failed: ${result.error}`);
  }
  
  return locationStats;
}

async function runContinuousSearch() {
  console.log('='.repeat(70));
  console.log('🚕 SHAREWAY - MULTI-PASSENGER CONTINUOUS SEARCH TEST');
  console.log('='.repeat(70));
  console.log(`👥 ${CONFIG.totalPassengers} Passengers | 🔄 ${CONFIG.searchInterval/1000}s interval`);
  console.log(`📍 Route: ${MAIN_ROUTE.pickup.name} → ${MAIN_ROUTE.dropoff.name}`);
  console.log(`🕐 Started at: ${new Date().toLocaleTimeString()}`);
  console.log(`🌐 Server: http://${CONFIG.hostname}:${CONFIG.port}`);
  console.log(`🎯 FEATURE: DISTINCT LOCATIONS FOR EACH PASSENGER`);
  console.log('='.repeat(70));
  
  // Display passenger profiles with PREDICTED DISTINCT LOCATIONS
  console.log('\n👤 PASSENGER PROFILES WITH DISTINCT LOCATIONS:');
  console.log('─'.repeat(80));
  PASSENGER_PROFILES.forEach(profile => {
    let color = '';
    let seatMessage = '';
    
    // Assign colors and seat messages
    if (profile.id === 1) color = '🟢';
    else if (profile.id === 2) color = '🔵';
    else if (profile.id === 3) color = '🟡';
    else if (profile.id === 4) color = '🟣';
    else color = '🔴';
    
    if (profile.seatsNeeded === 1) seatMessage = '1 seat (solo traveler)';
    else if (profile.seatsNeeded === 2) seatMessage = '2 seats (with friend)';
    
    // Calculate predicted distinct locations
    const predictedPickup = generateNearbyLocation(MAIN_ROUTE.pickup.lat, MAIN_ROUTE.pickup.lng, profile.id);
    const predictedDropoff = generateDestinationLocation(MAIN_ROUTE.dropoff.lat, MAIN_ROUTE.dropoff.lng, profile.id);
    
    console.log(`${color} ${profile.fullName}`);
    console.log(`   📱 ${profile.phone} (used as userId)`);
    console.log(`   ⭐ ${profile.rating} | 🚖 ${profile.totalRides} rides`);
    console.log(`   💬 "${profile.preferences.specialRequests}"`);
    console.log(`   🪑 Seat requirement: ${seatMessage}`);
    console.log(`   📍 PREDICTED UNIQUE PICKUP: ${predictedPickup.lat.toFixed(6)}, ${predictedPickup.lng.toFixed(6)}`);
    console.log(`   📍 PREDICTED UNIQUE DESTINATION: ${predictedDropoff.lat.toFixed(6)}, ${predictedDropoff.lng.toFixed(6)}`);
    console.log('   ─'.repeat(40));
  });
  
  console.log('\n📝 IMPORTANT FEATURES:');
  console.log('   • Each passenger gets DISTINCT pickup coordinates');
  console.log('   • Each passenger gets DISTINCT destination coordinates');
  console.log('   • Each passenger gets UNIQUE route points');
  console.log('   • MatchingService extracts individual locations from driver document');
  console.log('   • WebSocket sends individual locations to driver app');
  
  // Check server health first
  console.log('\n🔍 Initial server connection test...');
  const health = await healthCheck();
  
  if (!health.healthy) {
    console.log('\n⚠️ Server not responding. Please check:');
    console.log('   1. Is the server running? (node app.js)');
    console.log('   2. Is it on port 3000?');
    console.log('   3. Try: curl http://localhost:3000/api/health');
    return;
  }
  
  // Statistics tracking
  const searchStats = {
    totalSearches: 0,
    successfulSearches: 0,
    failedSearches: 0,
    matchesFound: 0,
    startTime: Date.now()
  };
  
  const locationStats = {
    totalUpdates: 0,
    successfulUpdates: 0,
    failedUpdates: 0
  };
  
  // Track individual passenger search counts
  const passengerSearchCounts = PASSENGER_PROFILES.map(() => 0);
  
  console.log('\n🚀 Starting continuous search loop with DISTINCT LOCATIONS...');
  console.log('Press Ctrl+C to stop\n');
  
  // Handle Ctrl+C
  let isRunning = true;
  process.on('SIGINT', () => {
    console.log('\n\n🛑 Stopping continuous search...');
    isRunning = false;
    displayFinalStats(searchStats, locationStats);
    process.exit(0);
  });
  
  // Start the search loop
  let currentPassengerIndex = 0;
  
  while (isRunning) {
    const passengerProfile = PASSENGER_PROFILES[currentPassengerIndex];
    const searchCount = ++passengerSearchCounts[currentPassengerIndex];
    
    // Send search request
    const searchResult = await sendPassengerSearch(passengerProfile, searchCount);
    searchStats.totalSearches++;
    
    // Display result
    displaySearchResult(searchResult, searchStats);
    
    // Send location update for this passenger (40% of the time)
    if (Math.random() < 0.4) {
      const locationResult = await updatePassengerLocation(
        passengerProfile.phone,
        passengerProfile.fullName,
        searchCount
      );
      locationStats.totalUpdates++;
      displayLocationUpdateResult(locationResult, locationStats);
    }
    
    // Test location sharing endpoints every 5th search
    if (searchCount % 5 === 0) {
      await testLocationSharing(passengerProfile.phone, passengerProfile.fullName);
    }
    
    // Move to next passenger
    currentPassengerIndex = (currentPassengerIndex + 1) % CONFIG.totalPassengers;
    
    // Display periodic summary every 10 searches
    if (searchStats.totalSearches % 10 === 0 && searchStats.totalSearches > 0) {
      displayPeriodicSummary(searchStats, locationStats);
    }
    
    // Wait before next search
    await new Promise(resolve => setTimeout(resolve, CONFIG.searchInterval));
  }
}

function displayPeriodicSummary(searchStats, locationStats) {
  const elapsedMinutes = ((Date.now() - searchStats.startTime) / 60000).toFixed(1);
  const searchesPerMinute = (searchStats.totalSearches / elapsedMinutes).toFixed(1);
  
  console.log('\n' + '📈'.repeat(30));
  console.log('📊 PERIODIC SUMMARY');
  console.log('─'.repeat(60));
  console.log(`⏱️  Elapsed time: ${elapsedMinutes} minutes`);
  console.log(`🔍 Total searches: ${searchStats.totalSearches}`);
  console.log(`📈 Searches/minute: ${searchesPerMinute}`);
  console.log(`✅ Successful: ${searchStats.successfulSearches} (${((searchStats.successfulSearches/searchStats.totalSearches)*100).toFixed(1)}%)`);
  console.log(`❌ Failed: ${searchStats.failedSearches} (${((searchStats.failedSearches/searchStats.totalSearches)*100).toFixed(1)}%)`);
  console.log(`🎯 Matches found: ${searchStats.matchesFound}`);
  console.log(`📍 Location updates: ${locationStats.successfulUpdates}✅ ${locationStats.failedUpdates}❌`);
  console.log('📈'.repeat(30) + '\n');
}

function displayFinalStats(searchStats, locationStats) {
  const elapsedMinutes = ((Date.now() - searchStats.startTime) / 60000).toFixed(1);
  const searchesPerMinute = (searchStats.totalSearches / elapsedMinutes).toFixed(1);
  
  console.log('\n' + '='.repeat(70));
  console.log('📊 FINAL STATISTICS');
  console.log('='.repeat(70));
  console.log(`⏱️  Total duration: ${elapsedMinutes} minutes`);
  console.log(`🔍 Total searches: ${searchStats.totalSearches}`);
  console.log(`📈 Average rate: ${searchesPerMinute} searches/minute`);
  console.log(`\n📊 Search Results:`);
  console.log(`   ✅ Successful: ${searchStats.successfulSearches} (${((searchStats.successfulSearches/searchStats.totalSearches)*100).toFixed(1)}%)`);
  console.log(`   ❌ Failed: ${searchStats.failedSearches} (${((searchStats.failedSearches/searchStats.totalSearches)*100).toFixed(1)}%)`);
  console.log(`   🎯 Matches found: ${searchStats.matchesFound}`);
  console.log(`\n📍 Location Updates:`);
  console.log(`   ✅ Successful: ${locationStats.successfulUpdates}`);
  console.log(`   ❌ Failed: ${locationStats.failedUpdates}`);
  console.log(`   📊 Success rate: ${locationStats.totalUpdates > 0 ? ((locationStats.successfulUpdates/locationStats.totalUpdates)*100).toFixed(1) : 0}%`);
  console.log('='.repeat(70));
}

// Quick test function
async function quickTest() {
  console.log('🚕 Running quick test for first and last passengers...\n');
  
  // Test the first passenger (1 seat)
  console.log('🧪 Testing passenger with 1 seat requirement:');
  const result1 = await sendPassengerSearch(PASSENGER_PROFILES[0], 1);
  
  console.log('\n' + '─'.repeat(50));
  console.log('QUICK TEST RESULT (1 seat):');
  console.log(`Passenger: ${result1.passengerName}`);
  console.log(`Phone/UserID: ${result1.passengerPhone}`);
  console.log(`Success: ${result1.success ? '✅ Yes' : '❌ No'}`);
  console.log(`Status: ${result1.statusCode}`);
  console.log(`Seats needed: ${result1.numberOfPassengers || 'N/A'} (solo traveler)`);
  console.log(`Unique pickup: ${result1.uniquePickup?.lat.toFixed(6)}, ${result1.uniquePickup?.lng.toFixed(6)}`);
  
  // Test the last passenger (2 seats)
  console.log('\n🧪 Testing passenger with 2 seat requirement:');
  const result2 = await sendPassengerSearch(PASSENGER_PROFILES[4], 1);
  
  console.log('\n' + '─'.repeat(50));
  console.log('QUICK TEST RESULT (2 seats):');
  console.log(`Passenger: ${result2.passengerName}`);
  console.log(`Phone/UserID: ${result2.passengerPhone}`);
  console.log(`Success: ${result2.success ? '✅ Yes' : '❌ No'}`);
  console.log(`Status: ${result2.statusCode}`);
  console.log(`Seats needed: ${result2.numberOfPassengers || 'N/A'} (traveling with friend)`);
  console.log(`Unique pickup: ${result2.uniquePickup?.lat.toFixed(6)}, ${result2.uniquePickup?.lng.toFixed(6)}`);
}

// Run test
if (require.main === module) {
  runContinuousSearch().catch(error => {
    console.error('\n💥 Script failed:', error);
    process.exit(1);
  });
}
