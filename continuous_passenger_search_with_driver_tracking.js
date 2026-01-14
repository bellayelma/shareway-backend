// realistic_passenger_search_location_updates.js - Realistic passenger search with location updates
const http = require('http');
const WebSocket = require('ws');
const readline = require('readline');

// ✅ CONFIGURATION FOR LOCAL SERVER
const CONFIG = {
  hostname: 'localhost',
  port: 3000,
  timeout: 15000,
  useHTTPS: false,
  searchInterval: 5000, // Time between passenger searches (5 seconds)
  totalPassengers: 5,   // Number of different passengers
  driverId: 'driver-real-123', // Real driver ID (your Flutter app)
  simulationDelay: 5000, // 5 seconds delay before simulating driver acceptance
};

// Define Ethiopian passenger names and details
const PASSENGER_PROFILES = [
  {
    id: 1,
    fullName: "Adugna Belay",
    phone: "+251911233344",
    rating: 4.8,
    totalRides: 15,
    photo: "https://cdn-icons-png.flaticon.com/512/1946/1946429.png",
    preferences: {
      preferredVehicleType: "car",
      specialRequests: "Window seat preferred"
    },
    seatsNeeded: 1
  },
  {
    id: 2,
    fullName: "Selamawit Mekonnen",
    phone: "+251922434455",
    rating: 4.9,
    totalRides: 32,
    photo: "https://cdn-icons-png.flaticon.com/512/4323/4323004.png",
    preferences: {
      preferredVehicleType: "car",
      specialRequests: "Quiet ride"
    },
    seatsNeeded: 1
  },
  {
    id: 3,
    fullName: "Tewodros Haile",
    phone: "+251933445596",
    rating: 4.5,
    totalRides: 8,
    photo: "https://cdn-icons-png.flaticon.com/512/3135/3135715.png",
    preferences: {
      preferredVehicleType: "car",
      specialRequests: "Air conditioning"
    },
    seatsNeeded: 1
  },
  {
    id: 4,
    fullName: "Mihret Abebe",
    phone: "+251944556977",
    rating: 4.7,
    totalRides: 21,
    photo: "https://cdn-icons-png.flaticon.com/512/6997/6997662.png",
    preferences: {
      preferredVehicleType: "car",
      specialRequests: "Extra legroom"
    },
    seatsNeeded: 1
  },
  {
    id: 5,
    fullName: "Daniel Girma",
    phone: "+251956667788",
    rating: 4.6,
    totalRides: 12,
    photo: "https://cdn-icons-png.flaticon.com/512/3011/3011270.png",
    preferences: {
      preferredVehicleType: "car",
      specialRequests: "Traveling with a friend"
    },
    seatsNeeded: 2
  }
];

// Main route from Adama to Dire Dawa
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

// ==================== WEBSOCKET AND STATE MANAGEMENT ====================
const passengerSockets = new Map(); // Map phone -> WebSocket
const activePassengers = new Map(); // Map phone -> passenger data
const locationTimers = new Map(); // Map phone -> interval timer
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// ==================== HELPER FUNCTIONS ====================
async function makeHttpRequest(path, method, data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: CONFIG.hostname,
      port: CONFIG.port,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };
    
    const req = http.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        try {
          const jsonResponse = JSON.parse(responseData);
          resolve({
            statusCode: res.statusCode,
            data: jsonResponse
          });
        } catch (error) {
          resolve({
            statusCode: res.statusCode,
            data: responseData
          });
        }
      });
    });
    
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    if (data) {
      req.write(JSON.stringify(data));
    }
    
    req.end();
  });
}

// ==================== PASSENGER WEBSOCKET CONNECTION ====================
function connectPassengerWebSocket(passengerPhone, passengerName, passengerId) {
  console.log(`\n🔌 Connecting WebSocket for ${passengerName} (${passengerPhone})...`);
  
  const ws = new WebSocket(`ws://localhost:3000/ws?userId=${passengerPhone}&role=passenger&platform=test&passengerId=${passengerId}`);
  
  ws.on('open', () => {
    console.log(`   ✅ WebSocket connected for ${passengerName}`);
    
    // Store the WebSocket
    passengerSockets.set(passengerPhone, ws);
    
    // Start sending location updates
    startPassengerLocationUpdates(passengerPhone, passengerName, passengerId);
  });
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      const time = new Date().toLocaleTimeString();
      
      console.log(`\n   [${time}] 📨 ${passengerName} received: ${message.type}`);
      
      switch (message.type) {
        case 'CONNECTED':
          console.log('     Connection confirmed');
          break;
          
        case 'DRIVER_LOCATION_UPDATE':
          console.log('     🚗 DRIVER LOCATION RECEIVED!');
          console.log(`     Driver: ${message.data?.driverId || 'Unknown'}`);
          console.log(`     Position: ${message.data?.latitude?.toFixed(6)}, ${message.data?.longitude?.toFixed(6)}`);
          console.log(`     Distance: ${calculateDistance(passengerPhone, message.data)?.toFixed(2)} km`);
          console.log(`     Mode: ${message.data?.trackingMode || 'normal'}`);
          console.log(`     Time: ${new Date(message.data?.timestamp || Date.now()).toLocaleTimeString()}`);
          
          // Check if this is our Flutter driver
          if ((message.data?.driverId || message.driverId) === CONFIG.driverId) {
            console.log('     ✅ THIS IS YOUR FLUTTER DRIVER APP!');
          }
          break;
          
        case 'MATCH_ACCEPTED':
          console.log('     🎯 MATCH ACCEPTED BY DRIVER!');
          console.log(`     Match ID: ${message.matchId || message.data?.matchId}`);
          console.log(`     Driver ID: ${message.driverId || message.data?.driverId}`);
          console.log(`     Vehicle: ${message.data?.vehicleType || 'Car'}`);
          console.log(`     ETA: ${message.data?.eta || 'Unknown'} minutes`);
          
          // Location sharing should start automatically
          console.log('     🔄 Location sharing will start in 5 seconds...');
          break;
          
        case 'LOCATION_SHARING_ENABLED':
          console.log('     🔗 LOCATION SHARING ENABLED!');
          console.log(`     Session ID: ${message.data?.sessionId}`);
          console.log(`     Partner: ${message.data?.partnerId} (driver)`);
          console.log(`     Bidirectional: ${message.data?.bidirectional ? 'Yes' : 'No'}`);
          console.log('     📡 Now receiving real-time driver locations');
          break;
          
        case 'DRIVER_TRACKING_MODE_CHANGED':
          console.log('     🔄 Driver changed tracking mode');
          console.log(`     Mode: ${message.data?.mode}`);
          console.log(`     Interval: ${message.data?.updateInterval}s`);
          break;
          
        case 'DRIVER_ARRIVED':
          console.log('     🎉 DRIVER HAS ARRIVED!');
          console.log(`     Driver is at pickup location`);
          break;
          
        default:
          if (message.type && !message.type.includes('_')) {
            console.log(`     Type: ${message.type}`);
          }
          if (message.data && Object.keys(message.data).length > 0) {
            console.log(`     Data: ${JSON.stringify(message.data, null, 2).substring(0, 100)}...`);
          }
      }
    } catch (error) {
      console.log(`   📨 Raw message from ${passengerName}:`, data.toString().substring(0, 100));
    }
  });
  
  ws.on('close', () => {
    console.log(`   🔌 WebSocket closed for ${passengerName}`);
    passengerSockets.delete(passengerPhone);
    
    // Clear location timer
    if (locationTimers.has(passengerPhone)) {
      clearInterval(locationTimers.get(passengerPhone));
      locationTimers.delete(passengerPhone);
    }
  });
  
  ws.on('error', (error) => {
    console.log(`   ❌ WebSocket error for ${passengerName}:`, error.message);
  });
  
  return ws;
}

// ==================== PASSENGER LOCATION UPDATES ====================
function startPassengerLocationUpdates(passengerPhone, passengerName, passengerId) {
  console.log(`   📍 Starting location updates for ${passengerName}...`);
  
  // Get base location
  const baseLocation = generateNearbyLocation(
    MAIN_ROUTE.pickup.lat,
    MAIN_ROUTE.pickup.lng,
    passengerId
  );
  
  let currentLat = baseLocation.lat;
  let currentLng = baseLocation.lng;
  let updateCount = 0;
  
  // Function to send location update
  const sendLocationUpdate = () => {
    const ws = passengerSockets.get(passengerPhone);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.log(`   ❌ WebSocket not connected for ${passengerName}`);
      return;
    }
    
    // Simulate small movement (waiting passenger)
    updateCount++;
    const movement = updateCount * 0.00001; // Very small movement
    const angle = (updateCount * 10) * (Math.PI / 180);
    
    currentLat = baseLocation.lat + Math.cos(angle) * movement;
    currentLng = baseLocation.lng + Math.sin(angle) * movement;
    
    const locationData = {
      type: 'LOCATION_UPDATE',
      userId: passengerPhone,
      userType: 'passenger',
      latitude: currentLat,
      longitude: currentLng,
      accuracy: 10 + Math.random() * 5,
      heading: Math.random() * 360,
      speed: 0.5 + Math.random() * 1.5, // Walking speed while waiting
      timestamp: Date.now(),
      altitude: 1500 + Math.random() * 100,
      altitudeAccuracy: 10,
      passengerId: passengerId,
      passengerName: passengerName
    };
    
    ws.send(JSON.stringify(locationData));
    
    // Also send via HTTP every 3rd update
    if (updateCount % 3 === 0) {
      sendHttpLocationUpdate(passengerPhone, passengerName, currentLat, currentLng);
    }
    
    const time = new Date().toLocaleTimeString();
    console.log(`   [${time}] 📍 ${passengerName} location sent: ${currentLat.toFixed(6)}, ${currentLng.toFixed(6)}`);
  };
  
  // Send first location immediately
  sendLocationUpdate();
  
  // Set up interval (every 10 seconds)
  const timer = setInterval(sendLocationUpdate, 10000);
  locationTimers.set(passengerPhone, timer);
  
  console.log(`   ⏱️  Location updates scheduled every 10 seconds`);
}

async function sendHttpLocationUpdate(passengerPhone, passengerName, lat, lng) {
  try {
    const locationData = {
      userId: passengerPhone,
      userType: 'passenger',
      latitude: lat,
      longitude: lng,
      accuracy: 12 + Math.random() * 8,
      speed: 1 + Math.random() * 2,
      heading: Math.random() * 360,
      timestamp: Date.now(),
      altitude: 1500 + Math.random() * 100,
      altitudeAccuracy: 10
    };
    
    const endpoint = `/api/location/${encodeURIComponent(passengerPhone)}/passenger/update`;
    const response = await makeHttpRequest(endpoint, 'POST', locationData);
    
    if (response.statusCode === 200) {
      console.log(`   ✅ HTTP location update for ${passengerName}`);
    }
  } catch (error) {
    // Silent fail for HTTP updates
  }
}

// ==================== SIMULATE DRIVER ACCEPTANCE ====================
function simulateDriverAcceptance(passengerPhone, passengerName, passengerId) {
  console.log(`\n⏳ Simulating driver acceptance for ${passengerName} in 5 seconds...`);
  
  setTimeout(() => {
    const ws = passengerSockets.get(passengerPhone);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.log(`   ❌ Cannot simulate acceptance - WebSocket not connected`);
      return;
    }
    
    console.log(`\n🎯 SIMULATING DRIVER ACCEPTANCE FOR ${passengerName}:`);
    console.log('   ─'.repeat(40));
    
    // 1. Send MATCH_ACCEPTED message (what server would send)
    const matchData = {
      type: 'MATCH_ACCEPTED',
      matchId: `match-${Date.now()}-${passengerId}`,
      driverId: CONFIG.driverId,
      driverName: "Test Driver",
      passengerId: passengerPhone,
      passengerName: passengerName,
      vehicleType: "Toyota Corolla",
      vehicleColor: "White",
      licensePlate: "3ABC123",
      driverRating: 4.7,
      driverTotalRides: 124,
      eta: 8 + Math.floor(Math.random() * 10), // 8-17 minutes
      fare: 750 + Math.floor(Math.random() * 100), // 750-850 ETB
      timestamp: Date.now()
    };
    
    // Send as if from server (in reality, server sends this)
    console.log(`   1. 📨 Sending MATCH_ACCEPTED to ${passengerName}`);
    console.log(`      Driver: ${CONFIG.driverId} (your Flutter app)`);
    console.log(`      Vehicle: Toyota Corolla (White)`);
    console.log(`      ETA: ${matchData.eta} minutes`);
    console.log(`      Fare: ${matchData.fare} ETB`);
    
    // 2. Send LOCATION_SHARING_ENABLED after 2 seconds
    setTimeout(() => {
      console.log(`\n   2. 🔗 ENABLING LOCATION SHARING for ${passengerName}`);
      console.log(`      Session established with driver`);
      console.log(`      Starting bidirectional location sharing`);
      
      const sharingData = {
        type: 'LOCATION_SHARING_ENABLED',
        data: {
          sessionId: `session-${Date.now()}-${passengerId}`,
          matchId: matchData.matchId,
          partnerId: CONFIG.driverId,
          partnerType: 'driver',
          partnerName: "Test Driver",
          bidirectional: true,
          updateInterval: 5, // seconds
          expiresAt: Date.now() + 3600000, // 1 hour
          timestamp: Date.now()
        }
      };
      
      // Send location sharing enabled
      ws.send(JSON.stringify(sharingData));
      
      // 3. Start simulating driver location updates (every 5 seconds)
      console.log(`\n   3. 📡 SIMULATING DRIVER LOCATION UPDATES`);
      console.log(`      Driver will send location every 5 seconds`);
      
      simulateDriverLocationUpdates(passengerPhone, passengerName, matchData.matchId);
      
    }, 2000);
    
  }, CONFIG.simulationDelay);
}

function simulateDriverLocationUpdates(passengerPhone, passengerName, matchId) {
  // Get passenger's location
  const passengerWs = passengerSockets.get(passengerPhone);
  if (!passengerWs) return;
  
  // Start sending simulated driver locations
  let driverLat = MAIN_ROUTE.pickup.lat + 0.01; // Driver starts 1km away
  let driverLng = MAIN_ROUTE.pickup.lng + 0.01;
  
  let updateCount = 0;
  const driverTimer = setInterval(() => {
    if (!passengerSockets.has(passengerPhone)) {
      clearInterval(driverTimer);
      return;
    }
    
    // Simulate driver moving toward passenger
    updateCount++;
    const progress = Math.min(updateCount * 0.05, 1); // 0 to 1
    driverLat = MAIN_ROUTE.pickup.lat + 0.01 - (0.01 * progress);
    driverLng = MAIN_ROUTE.pickup.lng + 0.01 - (0.01 * progress);
    
    const driverLocation = {
      type: 'DRIVER_LOCATION_UPDATE',
      data: {
        driverId: CONFIG.driverId,
        driverName: "Test Driver",
        matchId: matchId,
        passengerId: passengerPhone,
        latitude: driverLat,
        longitude: driverLng,
        accuracy: 5 + Math.random() * 5,
        speed: 40 + Math.random() * 20, // 40-60 km/h
        heading: 200 + Math.random() * 40,
        timestamp: Date.now(),
        trackingMode: 'normal',
        batteryLevel: 80 + Math.random() * 15,
        isMoving: true,
        distanceToPickup: calculateDriverDistance(passengerPhone, driverLat, driverLng),
        eta: Math.max(1, Math.floor(10 - (progress * 9))) // Decreasing ETA
      }
    };
    
    // Send to passenger
    passengerWs.send(JSON.stringify(driverLocation));
    
    const time = new Date().toLocaleTimeString();
    console.log(`   [${time}] 🚗 Driver location sent to ${passengerName}:`);
    console.log(`      Position: ${driverLat.toFixed(6)}, ${driverLng.toFixed(6)}`);
    console.log(`      Distance: ${driverLocation.data.distanceToPickup.toFixed(2)} km`);
    console.log(`      ETA: ${driverLocation.data.eta} minutes`);
    
    // Stop after 10 updates (50 seconds) or when driver arrives
    if (updateCount >= 10 || driverLocation.data.distanceToPickup < 0.1) {
      clearInterval(driverTimer);
      if (driverLocation.data.distanceToPickup < 0.1) {
        console.log(`\n🎉 DRIVER ARRIVED AT ${passengerName}'S LOCATION!`);
        passengerWs.send(JSON.stringify({
          type: 'DRIVER_ARRIVED',
          data: {
            driverId: CONFIG.driverId,
            matchId: matchId,
            timestamp: Date.now()
          }
        }));
      }
    }
    
  }, 5000); // Every 5 seconds
}

// ==================== DISTANCE CALCULATION ====================
function calculateDistance(passengerPhone, driverLocation) {
  if (!activePassengers.has(passengerPhone) || !driverLocation) return null;
  
  const passenger = activePassengers.get(passengerPhone);
  const passengerLat = passenger.currentLocation?.latitude || passenger.pickupLocation?.lat;
  const passengerLng = passenger.currentLocation?.longitude || passenger.pickupLocation?.lng;
  
  if (!passengerLat || !passengerLng) return null;
  
  const driverLat = driverLocation.latitude || driverLocation.data?.latitude;
  const driverLng = driverLocation.longitude || driverLocation.data?.longitude;
  
  if (!driverLat || !driverLng) return null;
  
  // Haversine formula
  const R = 6371; // Earth's radius in km
  const dLat = (driverLat - passengerLat) * Math.PI / 180;
  const dLng = (driverLng - passengerLng) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(passengerLat * Math.PI / 180) * Math.cos(driverLat * Math.PI / 180) * 
    Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function calculateDriverDistance(passengerPhone, driverLat, driverLng) {
  if (!activePassengers.has(passengerPhone)) return 0;
  
  const passenger = activePassengers.get(passengerPhone);
  const passengerLat = passenger.currentLocation?.latitude || passenger.pickupLocation?.lat;
  const passengerLng = passenger.currentLocation?.longitude || passenger.pickupLocation?.lng;
  
  if (!passengerLat || !passengerLng) return 0;
  
  // Simple distance calculation
  const latDiff = (driverLat - passengerLat) * 111.32;
  const lngDiff = (driverLng - passengerLng) * 111.32 * Math.cos(passengerLat * Math.PI / 180);
  return Math.sqrt(latDiff * latDiff + lngDiff * lngDiff);
}

// ==================== LOCATION GENERATION (from your script) ====================
function generateNearbyLocation(baseLat, baseLng, passengerId) {
  const angle = (passengerId * 72) * (Math.PI / 180);
  const distanceInKm = 0.5 + (passengerId * 0.3);
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

function generateDestinationLocation(baseLat, baseLng, passengerId) {
  const angle = ((passengerId * 50) + 30) * (Math.PI / 180);
  const distanceInKm = 0.2 + (passengerId * 0.15);
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

// ==================== CREATE PASSENGER ====================
function createPassenger(passengerProfile, searchCount) {
  const timestamp = Date.now();
  const passengerId = passengerProfile.id;
  
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
  
  const passengerData = {
    userId: passengerProfile.phone,
    userType: 'passenger',
    rideType: "immediate",
    searchNumber: searchCount,
    passengerName: passengerProfile.fullName,
    passengerPhone: passengerProfile.phone,
    passengerPhotoUrl: passengerProfile.photo,
    pickup: {
      address: `${MAIN_ROUTE.pickup.name} - Passenger ${passengerId}`,
      location: pickupLocation
    },
    dropoff: {
      address: `${MAIN_ROUTE.dropoff.name} - Passenger ${passengerId}`,
      location: dropoffLocation
    },
    numberOfPassengers: passengerProfile.seatsNeeded,
    passengerCount: passengerProfile.seatsNeeded,
    routePoints: MAIN_ROUTE.routePoints.map((point, index) => ({
      lat: point.lat + (passengerId * 0.0001 * Math.cos(index * 0.5)),
      lng: point.lng + (passengerId * 0.0001 * Math.sin(index * 0.5))
    })),
    coordinates: {
      pickupLat: pickupLocation.lat,
      pickupLng: pickupLocation.lng,
      destLat: dropoffLocation.lat,
      destLng: dropoffLocation.lng
    },
    passengerRating: passengerProfile.rating,
    totalRides: passengerProfile.totalRides,
    isVerified: Math.random() > 0.3,
    ridePreferences: {
      maxWaitTime: 15 + Math.floor(Math.random() * 30),
      preferredVehicleType: passengerProfile.preferences.preferredVehicleType,
      specialRequests: passengerProfile.preferences.specialRequests,
      maxWalkDistance: 0.2 + (Math.random() * 0.8)
    },
    distance: 320 + Math.floor(Math.random() * 20) - 10,
    duration: 360 + Math.floor(Math.random() * 30) - 15,
    estimatedFare: 800 + Math.floor(Math.random() * 100) - 50,
    searchId: `passenger_${passengerId}_search_${timestamp}`,
    passengerProfileId: passengerId,
    currentLocation: {
      latitude: pickupLocation.lat,
      longitude: pickupLocation.lng,
      accuracy: 10 + Math.random() * 20,
      timestamp: timestamp
    },
    pickupLocation: pickupLocation,
    destinationLocation: dropoffLocation
  };
  
  // Store in active passengers
  activePassengers.set(passengerProfile.phone, passengerData);
  
  return passengerData;
}

// ==================== SEND PASSENGER SEARCH ====================
async function sendPassengerSearch(passengerProfile, searchCount) {
  try {
    const passengerData = createPassenger(passengerProfile, searchCount);
    
    const response = await makeHttpRequest('/api/match/search', 'POST', passengerData);
    
    console.log(`\n📤 Sending search for ${passengerData.passengerName}...`);
    console.log(`   Phone: ${passengerData.userId}`);
    console.log(`   📍 UNIQUE PICKUP: ${passengerData.pickup.location.lat.toFixed(6)}, ${passengerData.pickup.location.lng.toFixed(6)}`);
    console.log(`   🪑 Seats: ${passengerData.numberOfPassengers}`);
    
    if (response.statusCode === 200) {
      console.log(`   ✅ Search successful!`);
      
      // Connect WebSocket for this passenger
      connectPassengerWebSocket(passengerProfile.phone, passengerProfile.fullName, passengerProfile.id);
      
      // Schedule driver acceptance simulation (5 seconds later)
      simulateDriverAcceptance(passengerProfile.phone, passengerProfile.fullName, passengerProfile.id);
    }
    
    return {
      success: response.statusCode === 200,
      passengerName: passengerProfile.fullName,
      passengerPhone: passengerProfile.phone,
      statusCode: response.statusCode
    };
  } catch (error) {
    console.log(`   ❌ Search error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// ==================== MAIN LOOP ====================
async function runRealisticTest() {
  console.log('='.repeat(70));
  console.log('🚕 REALISTIC PASSENGER-DRIVER LOCATION SHARING TEST');
  console.log('='.repeat(70));
  console.log(`👥 ${CONFIG.totalPassengers} Passengers | 🔄 ${CONFIG.searchInterval/1000}s interval`);
  console.log(`🎯 FEATURE: Auto driver acceptance in 5 seconds`);
  console.log(`📡 FEATURE: Real-time location sharing simulation`);
  console.log(`🚗 Driver ID: ${CONFIG.driverId} (your Flutter app)`);
  console.log('='.repeat(70));
  
  // Check server health
  try {
    const health = await makeHttpRequest('/api/health', 'GET');
    if (health.statusCode !== 200) {
      throw new Error('Server not responding');
    }
    console.log('✅ Server is healthy');
  } catch (error) {
    console.log('❌ Server not responding:', error.message);
    console.log('💡 Make sure your server is running: node app.js');
    return;
  }
  
  console.log('\n📝 TEST FLOW:');
  console.log('   1. Passenger sends search request');
  console.log('   2. WebSocket connects for location updates');
  console.log('   3. Passenger sends location every 10s (WebSocket + HTTP)');
  console.log('   4. After 5s: Driver accepts match');
  console.log('   5. Location sharing enabled');
  console.log('   6. Driver sends location every 5s');
  console.log('   7. Passenger receives real-time driver locations');
  console.log('\n🚀 Starting test in 3 seconds...\n');
  
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // Start with first passenger
  let currentPassengerIndex = 0;
  let searchCount = 0;
  
  const interval = setInterval(async () => {
    if (currentPassengerIndex >= CONFIG.totalPassengers) {
      console.log('\n✅ All passengers have been processed');
      console.log('⏳ Continuing to send location updates for connected passengers...');
      console.log('Press Ctrl+C to stop\n');
      clearInterval(interval);
      return;
    }
    
    const passengerProfile = PASSENGER_PROFILES[currentPassengerIndex];
    searchCount++;
    
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`PASSENGER ${currentPassengerIndex + 1}/${CONFIG.totalPassengers}: ${passengerProfile.fullName}`);
    console.log(`${'─'.repeat(70)}`);
    
    await sendPassengerSearch(passengerProfile, searchCount);
    
    currentPassengerIndex++;
    
    // If all passengers processed, stop the interval
    if (currentPassengerIndex >= CONFIG.totalPassengers) {
      clearInterval(interval);
    }
    
  }, CONFIG.searchInterval);
  
  // Setup command interface
  setTimeout(() => {
    setupCommandInterface();
  }, (CONFIG.totalPassengers * CONFIG.searchInterval) + 5000);
}

// ==================== COMMAND INTERFACE ====================
function setupCommandInterface() {
  console.log('\n' + '='.repeat(60));
  console.log('📝 TEST COMMANDS:');
  console.log('='.repeat(60));
  console.log('   "list"       - List all connected passengers');
  console.log('   "status"     - Check location sharing status');
  console.log('   "driver"     - Check driver WebSocket info');
  console.log('   "manual"     - Manually trigger driver acceptance');
  console.log('   "quit"       - Exit test');
  console.log('='.repeat(60));
  console.log('\n⏳ Waiting for commands...\n');
  
  rl.on('line', async (input) => {
    const command = input.trim().toLowerCase();
    
    switch (command) {
      case 'list':
        listConnectedPassengers();
        break;
        
      case 'status':
        await checkLocationSharingStatus();
        break;
        
      case 'driver':
        await checkDriverWebSocketInfo();
        break;
        
      case 'manual':
        await manualTriggerAcceptance();
        break;
        
      case 'quit':
        console.log('\n🛑 Stopping test...');
        passengerSockets.forEach(ws => ws.close());
        locationTimers.forEach(timer => clearInterval(timer));
        rl.close();
        process.exit(0);
        break;
        
      default:
        console.log('❓ Unknown command. Available: list, status, driver, manual, quit');
    }
    
    console.log('\n⏳ Waiting for next command...');
  });
}

function listConnectedPassengers() {
  console.log('\n👥 CONNECTED PASSENGERS:');
  console.log('─'.repeat(60));
  
  if (passengerSockets.size === 0) {
    console.log('   No passengers connected');
    return;
  }
  
  passengerSockets.forEach((ws, phone) => {
    const passenger = PASSENGER_PROFILES.find(p => p.phone === phone);
    if (passenger) {
      const status = ws.readyState === WebSocket.OPEN ? '✅ Connected' : '❌ Disconnected';
      console.log(`   ${passenger.fullName}`);
      console.log(`   📱 ${phone}`);
      console.log(`   🔌 WebSocket: ${status}`);
      console.log(`   📍 Location updates: ${locationTimers.has(phone) ? 'Active' : 'Inactive'}`);
      console.log('   ─'.repeat(40));
    }
  });
}

async function checkLocationSharingStatus() {
  console.log('\n📊 LOCATION SHARING STATUS:');
  
  for (const [phone, passenger] of activePassengers) {
    try {
      const endpoint = `/api/location/${encodeURIComponent(phone)}/passenger/status`;
      const response = await makeHttpRequest(endpoint, 'GET');
      
      const passengerProfile = PASSENGER_PROFILES.find(p => p.phone === phone);
      console.log(`\n   👤 ${passengerProfile?.fullName || phone}:`);
      
      if (response.statusCode === 200) {
        console.log('   ✅ Status available');
        if (response.data && typeof response.data === 'object') {
          console.log('   Data:', JSON.stringify(response.data, null, 2));
        }
      } else {
        console.log(`   ❌ Status check failed: ${response.statusCode}`);
      }
    } catch (error) {
      console.log(`   ❌ Error for ${phone}: ${error.message}`);
    }
  }
}

async function checkDriverWebSocketInfo() {
  console.log('\n🔍 CHECKING DRIVER WEBSOCKET:');
  
  try {
    const response = await makeHttpRequest('/api/debug/websocket', 'GET');
    
    if (response.statusCode === 200) {
      console.log('   ✅ WebSocket status retrieved');
      
      // Look for our driver
      if (response.data?.users) {
        const driverConnected = response.data.users.some(user => 
          user.userId === CONFIG.driverId || 
          (user.role === 'driver' && user.userId.includes('driver'))
        );
        
        if (driverConnected) {
          console.log('   ✅ Your Flutter driver app is connected!');
        } else {
          console.log('   ❌ Your Flutter driver app is NOT connected.');
          console.log('   💡 Make sure your Flutter app is running and connected');
        }
      }
    }
  } catch (error) {
    console.log('   ❌ Error:', error.message);
  }
}

async function manualTriggerAcceptance() {
  console.log('\n🎯 MANUALLY TRIGGER DRIVER ACCEPTANCE:');
  
  if (passengerSockets.size === 0) {
    console.log('   No passengers connected');
    return;
  }
  
  // Get first connected passenger
  const phone = Array.from(passengerSockets.keys())[0];
  const passengerProfile = PASSENGER_PROFILES.find(p => p.phone === phone);
  
  if (passengerProfile) {
    console.log(`   Triggering for: ${passengerProfile.fullName}`);
    simulateDriverAcceptance(phone, passengerProfile.fullName, passengerProfile.id);
  }
}

// ==================== CLEANUP ====================
process.on('SIGINT', () => {
  console.log('\n\n🛑 Test interrupted by user');
  passengerSockets.forEach(ws => ws.close());
  locationTimers.forEach(timer => clearInterval(timer));
  rl.close();
  process.exit(0);
});

// Run the test
if (require.main === module) {
  runRealisticTest().catch(error => {
    console.error('\n💥 Test failed:', error);
    process.exit(1);
  });
}
