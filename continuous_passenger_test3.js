// continuous_passenger_movement_fixed.js
const http = require('http');
const readline = require('readline');

// ✅ CONFIGURATION FOR YOUR LOCAL SERVER
const CONFIG = {
  hostname: 'localhost',
  port: 3000,
  timeout: 10000,
  searchInterval: 5000,
  movementUpdateInterval: 3000, // Updates every 3 seconds
  acceptanceDelay: 5000, // Wait 5 seconds before driver accepts
  maxContinuousHours: 24
};

// Ethiopian passenger profiles
const PASSENGER_PROFILES = [
  {
    id: 1,
    fullName: "Adugna Belay",
    phone: "+251911233344",
    rating: 4.8,
    photo: "https://cdn-icons-png.flaticon.com/512/1946/1946429.png",
    seatsNeeded: 1,
    baseLat: 8.549995,
    baseLng: 39.266714
  },
  {
    id: 2,
    fullName: "Selamawit Mekonnen",
    phone: "+251922434455",
    rating: 4.9,
    photo: "https://cdn-icons-png.flaticon.com/512/4323/4323004.png",
    seatsNeeded: 1,
    baseLat: 8.550500,
    baseLng: 39.267000
  },
  {
    id: 3,
    fullName: "Tewodros Haile",
    phone: "+251933445596",
    rating: 4.5,
    photo: "https://cdn-icons-png.flaticon.com/512/3135/3135715.png",
    seatsNeeded: 1,
    baseLat: 8.551000,
    baseLng: 39.267500
  }
];

// Driver simulation profile
const DRIVER_PROFILE = {
  id: "DRIVER_001",
  name: "Abebe Kebede",
  phone: "+251911000000",
  driverId: "+251911240957", // From your logs
  userId: "y1qH8ff3zWawz6IgvXM755Lq6Pq1" // From your logs
};

// ==================== MOVEMENT SIMULATOR ====================
class MovementSimulator {
  constructor(passengerPhone, baseLat, baseLng) {
    this.passengerPhone = passengerPhone;
    this.baseLat = baseLat;
    this.baseLng = baseLng;
    this.currentLat = baseLat;
    this.currentLng = baseLng;
    this.step = 0;
    this.totalDistance = 0;
    this.startTime = Date.now();
    this.isActive = true;
    this.tripStatus = 'searching'; // searching → accepted → enroute_to_pickup → pickup_arrived → passenger_onboard → enroute_to_destination → arrived → completed
    this.matchId = null;
    this.accepted = false;
    
    // Movement parameters
    this.walkingSpeed = 0.00001; // Degrees per update (walking)
    this.vehicleSpeed = 0.00005; // Degrees per update (in vehicle)
    this.direction = Math.random() * 2 * Math.PI;
  }

  generateNextPosition() {
    this.step++;
    
    let latChange, lngChange;
    
    switch(this.tripStatus) {
      case 'searching':
        // Random walking while searching
        this.direction += (Math.random() - 0.5) * 0.5;
        latChange = Math.cos(this.direction) * this.walkingSpeed;
        lngChange = Math.sin(this.direction) * this.walkingSpeed;
        break;
        
      case 'accepted':
      case 'enroute_to_pickup':
        // Move towards a central pickup point
        const pickupLat = 8.550000;
        const pickupLng = 39.267000;
        latChange = (pickupLat - this.currentLat) * 0.1;
        lngChange = (pickupLng - this.currentLng) * 0.1;
        break;
        
      case 'pickup_arrived':
        // Minimal movement (waiting)
        latChange = (Math.random() - 0.5) * 0.000001;
        lngChange = (Math.random() - 0.5) * 0.000001;
        break;
        
      case 'passenger_onboard':
      case 'enroute_to_destination':
        // Move towards destination (Dire Dawa)
        const destLat = 9.589549;
        const destLng = 41.866169;
        latChange = (destLat - this.currentLat) * 0.01;
        lngChange = (destLng - this.currentLng) * 0.01;
        break;
        
      case 'arrived':
        // Stop moving
        latChange = 0;
        lngChange = 0;
        break;
        
      default:
        latChange = (Math.random() - 0.5) * this.walkingSpeed;
        lngChange = (Math.random() - 0.5) * this.walkingSpeed;
    }
    
    // Add small random GPS drift
    latChange += (Math.random() - 0.5) * 0.000001;
    lngChange += (Math.random() - 0.5) * 0.000001;
    
    // Update position
    this.currentLat += latChange;
    this.currentLng += lngChange;
    
    // Calculate distance moved (approx)
    const distanceMoved = Math.sqrt(latChange * latChange + lngChange * lngChange) * 111320; // Convert to meters
    this.totalDistance += distanceMoved;
    
    return {
      lat: this.currentLat,
      lng: this.currentLng,
      step: this.step,
      totalDistance: this.totalDistance,
      elapsedTime: (Date.now() - this.startTime) / 1000,
      status: this.tripStatus,
      speed: this.tripStatus.includes('enroute') ? 15 : 5, // km/h
      heading: (this.direction * 180 / Math.PI) % 360,
      accuracy: this.tripStatus === 'passenger_onboard' ? 3 : 8 // Better accuracy in vehicle
    };
  }

  updateStatus(newStatus) {
    console.log(`   🔄 ${this.passengerPhone}: ${this.tripStatus} → ${newStatus}`);
    this.tripStatus = newStatus;
  }

  acceptMatch(matchId) {
    this.matchId = matchId;
    this.accepted = true;
    this.updateStatus('accepted');
  }

  stop() {
    this.isActive = false;
    console.log(`   ⏹️  Stopped movement for ${this.passengerPhone}`);
  }
}

// Store active simulations
const activeSimulations = new Map();

// ==================== API FUNCTIONS ====================
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
              data: jsonResponse
            });
          } else {
            resolve({
              statusCode: res.statusCode,
              data: {}
            });
          }
        } catch (error) {
          resolve({
            statusCode: res.statusCode,
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
      reject(new Error(`Request timeout`));
    });
    
    if (data) {
      req.write(JSON.stringify(data));
    }
    
    req.end();
  });
}

// Send passenger search request
async function sendPassengerSearch(passengerProfile) {
  try {
    // Initialize simulator if not exists
    if (!activeSimulations.has(passengerProfile.phone)) {
      const simulator = new MovementSimulator(
        passengerProfile.phone,
        passengerProfile.baseLat,
        passengerProfile.baseLng
      );
      activeSimulations.set(passengerProfile.phone, simulator);
    }
    
    const simulator = activeSimulations.get(passengerProfile.phone);
    const position = simulator.generateNextPosition();
    
    const passengerData = {
      userId: passengerProfile.phone,
      userType: 'passenger',
      rideType: "immediate",
      searchId: `search_${Date.now()}_${passengerProfile.id}`,
      
      passengerName: passengerProfile.fullName,
      passengerPhone: passengerProfile.phone,
      passengerPhoto: passengerProfile.photo,
      passengerRating: passengerProfile.rating,
      totalRides: 50,
      isVerified: true,
      
      pickup: {
        address: `Adama - ${passengerProfile.fullName}`,
        location: { lat: position.lat, lng: position.lng },
        name: `Pickup - ${passengerProfile.fullName}`
      },
      dropoff: {
        address: "Dire Dawa City Center",
        location: { lat: 9.589549, lng: 41.866169 },
        name: "Dire Dawa"
      },
      
      numberOfPassengers: passengerProfile.seatsNeeded,
      passengerCount: passengerProfile.seatsNeeded,
      
      ridePreferences: {
        maxWaitTime: 10,
        preferredVehicleType: "car",
        specialRequests: "None",
        maxWalkDistance: 0.2
      },
      
      distance: 320,
      duration: 360,
      estimatedFare: 800,
      
      currentLocation: {
        latitude: position.lat,
        longitude: position.lng,
        accuracy: position.accuracy,
        speed: position.speed,
        heading: position.heading,
        timestamp: Date.now()
      },
      
      status: simulator.tripStatus
    };
    
    const options = {
      hostname: CONFIG.hostname,
      port: CONFIG.port,
      path: '/api/match/search',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };
    
    console.log(`\n🟢 Starting search: ${passengerProfile.fullName}`);
    console.log(`   📱 Phone: ${passengerProfile.phone}`);
    console.log(`   📍 Location: ${position.lat.toFixed(6)}, ${position.lng.toFixed(6)}`);
    console.log(`   🎯 Status: ${simulator.tripStatus}`);
    
    const response = await makeRequest(options, passengerData);
    
    return {
      success: response.statusCode === 200,
      passengerPhone: passengerProfile.phone,
      passengerName: passengerProfile.fullName,
      statusCode: response.statusCode,
      data: response.data,
      location: { lat: position.lat, lng: position.lng }
    };
  } catch (error) {
    console.error(`   ❌ Search error: ${error.message}`);
    return {
      success: false,
      passengerName: passengerProfile.fullName,
      error: error.message
    };
  }
}

// Update passenger location (CONTINUOUS UPDATES)
async function updatePassengerLocation(passengerPhone) {
  try {
    const simulator = activeSimulations.get(passengerPhone);
    
    if (!simulator || !simulator.isActive) {
      return { success: false, shouldContinue: false };
    }
    
    // Generate next position
    const position = simulator.generateNextPosition();
    
    const locationData = {
      userId: passengerPhone,
      userType: 'passenger',
      latitude: position.lat,
      longitude: position.lng,
      accuracy: position.accuracy,
      speed: position.speed, // km/h
      heading: position.heading,
      timestamp: Date.now(),
      altitude: 1500,
      altitudeAccuracy: 15,
      batteryLevel: 85,
      
      // Trip context (important for driver to see movement)
      tripId: simulator.matchId || `trip_${passengerPhone}_${Date.now()}`,
      tripStatus: simulator.tripStatus,
      
      // For testing
      isMock: true,
      simulation: {
        step: position.step,
        totalDistance: position.totalDistance,
        status: position.status
      }
    };
    
    // Use the correct endpoint from your logs
    const endpointPath = '/api/location/update';
    
    const options = {
      hostname: CONFIG.hostname,
      port: CONFIG.port,
      path: endpointPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    };
    
    const response = await makeRequest(options, locationData);
    
    // Display update info
    const speedKmh = position.speed.toFixed(1);
    const distanceM = position.totalDistance.toFixed(1);
    
    console.log(`   📍 Step ${position.step}: ${position.lat.toFixed(6)}, ${position.lng.toFixed(6)}`);
    console.log(`   🚀 Speed: ${speedKmh} km/h | Distance: ${distanceM} m`);
    console.log(`   🎯 Status: ${simulator.tripStatus}`);
    
    // Auto-advance trip status based on conditions
    await autoAdvanceTripStatus(simulator, position);
    
    return {
      success: response.statusCode === 200,
      passengerPhone: passengerPhone,
      location: position,
      step: position.step,
      tripStatus: simulator.tripStatus,
      shouldContinue: simulator.isActive && simulator.tripStatus !== 'completed',
      data: response.data
    };
  } catch (error) {
    console.error(`   ❌ Update error: ${error.message}`);
    return {
      success: false,
      error: error.message,
      shouldContinue: true // Continue despite errors
    };
  }
}

// Auto-advance trip status
async function autoAdvanceTripStatus(simulator, position) {
  const currentStatus = simulator.tripStatus;
  let newStatus = currentStatus;
  
  switch(currentStatus) {
    case 'searching':
      // Auto-accept after some time
      if (position.step > 5 && Math.random() < 0.1) {
        newStatus = 'accepted';
        // Simulate match acceptance
        simulator.acceptMatch(`match_${Date.now()}_${simulator.passengerPhone}`);
      }
      break;
      
    case 'accepted':
      if (position.step > 2) newStatus = 'enroute_to_pickup';
      break;
      
    case 'enroute_to_pickup':
      // Check if close to pickup
      const pickupDist = Math.sqrt(
        Math.pow(position.lat - 8.550000, 2) + 
        Math.pow(position.lng - 39.267000, 2)
      ) * 111320; // Convert to meters
      
      if (pickupDist < 20) { // Within 20 meters
        newStatus = 'pickup_arrived';
      }
      break;
      
    case 'pickup_arrived':
      if (position.step > 3) newStatus = 'passenger_onboard';
      break;
      
    case 'passenger_onboard':
      if (position.step > 2) newStatus = 'enroute_to_destination';
      break;
      
    case 'enroute_to_destination':
      // Check if close to destination
      const destDist = Math.sqrt(
        Math.pow(position.lat - 9.589549, 2) + 
        Math.pow(position.lng - 41.866169, 2)
      ) * 111320;
      
      if (destDist < 50) { // Within 50 meters
        newStatus = 'arrived';
      }
      break;
      
    case 'arrived':
      if (position.step > 2) {
        newStatus = 'completed';
        simulator.isActive = false;
      }
      break;
  }
  
  if (newStatus !== currentStatus) {
    simulator.updateStatus(newStatus);
  }
}

// Simulate driver accepting the passenger (optional)
async function simulateDriverAcceptance(passengerPhone) {
  try {
    const options = {
      hostname: CONFIG.hostname,
      port: CONFIG.port,
      path: '/api/trip/accept',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    };
    
    const acceptanceData = {
      passengerPhone: passengerPhone,
      driverId: DRIVER_PROFILE.driverId,
      driverName: DRIVER_PROFILE.name,
      driverPhone: DRIVER_PROFILE.phone,
      timestamp: Date.now()
    };
    
    const response = await makeRequest(options, acceptanceData);
    
    if (response.statusCode === 200) {
      const simulator = activeSimulations.get(passengerPhone);
      if (simulator) {
        simulator.acceptMatch(response.data.matchId || `match_${Date.now()}`);
      }
    }
    
    return { success: response.statusCode === 200 };
  } catch (error) {
    console.error(`   ❌ Acceptance error: ${error.message}`);
    return { success: false };
  }
}

// ==================== CONTINUOUS SIMULATION ====================

// Continuous stream for a single passenger
async function continuousPassengerStream(passengerProfile, durationMinutes = 10) {
  console.log(`\n📡 Starting continuous stream for: ${passengerProfile.fullName}`);
  console.log('─'.repeat(60));
  
  // Send initial search
  const searchResult = await sendPassengerSearch(passengerProfile);
  
  if (!searchResult.success) {
    console.log('❌ Initial search failed, stopping');
    return;
  }
  
  console.log(`✅ Search started, beginning continuous updates...`);
  console.log(`   ⏱️  Updates every ${CONFIG.movementUpdateInterval/1000}s`);
  console.log(`   🕐 Duration: ${durationMinutes} minutes`);
  
  let updateCount = 0;
  let errorCount = 0;
  const startTime = Date.now();
  const durationMs = durationMinutes * 60 * 1000;
  
  // Main update loop
  while (Date.now() - startTime < durationMs) {
    updateCount++;
    
    const updateResult = await updatePassengerLocation(passengerProfile.phone);
    
    if (!updateResult.success) {
      errorCount++;
    }
    
    // Check if trip completed
    if (updateResult.tripStatus === 'completed') {
      console.log(`   🏁 Trip completed after ${updateCount} updates`);
      break;
    }
    
    // Wait for next update
    await new Promise(resolve => setTimeout(resolve, CONFIG.movementUpdateInterval));
  }
  
  const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
  
  console.log(`\n📊 Stream completed:`);
  console.log(`   🔄 Total updates: ${updateCount}`);
  console.log(`   ✅ Successful: ${updateCount - errorCount}`);
  console.log(`   ❌ Errors: ${errorCount}`);
  console.log(`   ⏱️  Duration: ${elapsedSeconds}s`);
  console.log(`   🎯 Final status: ${activeSimulations.get(passengerProfile.phone)?.tripStatus || 'unknown'}`);
}

// Run continuous simulation for all passengers
async function runContinuousSimulation() {
  console.log('='.repeat(70));
  console.log('🚕 CONTINUOUS PASSENGER MOVEMENT SIMULATION');
  console.log('='.repeat(70));
  console.log(`👥 ${PASSENGER_PROFILES.length} Passengers`);
  console.log(`🔄 Updates every ${CONFIG.movementUpdateInterval/1000}s`);
  console.log(`🌐 Server: http://${CONFIG.hostname}:${CONFIG.port}`);
  console.log('='.repeat(70));
  
  // Check server health
  console.log('\n🔍 Checking server health...');
  try {
    const options = {
      hostname: CONFIG.hostname,
      port: CONFIG.port,
      path: '/api/health',
      method: 'GET'
    };
    
    const response = await makeRequest(options);
    if (response.statusCode === 200) {
      console.log('✅ Server is responding');
    } else {
      console.log(`❌ Server status: ${response.statusCode}`);
      return;
    }
  } catch (error) {
    console.log(`❌ Server not responding: ${error.message}`);
    return;
  }
  
  // Run simulation for each passenger
  for (const passenger of PASSENGER_PROFILES) {
    console.log(`\n${'▶'.repeat(35)}`);
    console.log(`STARTING: ${passenger.fullName}`);
    console.log(`${'▶'.repeat(35)}`);
    
    await continuousPassengerStream(passenger, 10); // 10 minutes each
    
    // Brief pause between passengers
    if (passenger.id < PASSENGER_PROFILES.length) {
      console.log('\n⏸️  Pausing before next passenger...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  console.log('\n' + '='.repeat(70));
  console.log('✅ ALL SIMULATIONS COMPLETED');
  console.log('='.repeat(70));
}

// Quick test for specific passenger
async function quickTest(passengerIndex = 0, minutes = 5) {
  const passenger = PASSENGER_PROFILES[passengerIndex];
  console.log(`\n⚡ QUICK TEST: ${passenger.fullName} (${minutes} minutes)`);
  console.log('─'.repeat(60));
  
  await continuousPassengerStream(passenger, minutes);
}

// Start specific passenger (runs indefinitely)
async function startPassenger(passengerPhone) {
  const passenger = PASSENGER_PROFILES.find(p => p.phone === passengerPhone);
  if (!passenger) {
    console.error(`Passenger ${passengerPhone} not found`);
    return;
  }
  
  console.log(`\n♾️  Starting INDEFINITE stream for: ${passenger.fullName}`);
  console.log('─'.repeat(60));
  
  // Send initial search
  await sendPassengerSearch(passenger);
  
  let step = 0;
  
  // Run indefinitely
  while (true) {
    step++;
    
    const updateResult = await updatePassengerLocation(passengerPhone);
    
    if (updateResult.tripStatus === 'completed') {
      console.log(`   🏁 Trip completed, restarting search...`);
      // Restart the cycle
      await sendPassengerSearch(passenger);
    }
    
    await new Promise(resolve => setTimeout(resolve, CONFIG.movementUpdateInterval));
    
    // Status update every 30 steps
    if (step % 30 === 0) {
      const simulator = activeSimulations.get(passengerPhone);
      console.log(`\n📊 Status update after ${step} updates:`);
      console.log(`   🎯 Current status: ${simulator?.tripStatus}`);
      console.log(`   📍 Location: ${simulator?.currentLat?.toFixed(6)}, ${simulator?.currentLng?.toFixed(6)}`);
      console.log(`   🕐 Running for: ${((Date.now() - simulator?.startTime) / 60000).toFixed(1)} minutes`);
    }
  }
}

// ==================== MAIN EXECUTION ====================
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.includes('--quick')) {
    const passengerIndex = parseInt(args[1]) || 0;
    const minutes = parseInt(args[2]) || 5;
    quickTest(passengerIndex, minutes).catch(console.error);
  } else if (args.includes('--start')) {
    const phone = args[1];
    if (phone) {
      startPassenger(phone).catch(console.error);
    } else {
      console.log('Usage: node continuous_passenger_movement_fixed.js --start +251911233344');
    }
  } else if (args.includes('--help')) {
    console.log(`
Usage: node continuous_passenger_movement_fixed.js [options]

Options:
  --quick [index] [minutes]  Quick test (default: passenger 0, 5 minutes)
  --start [phone]            Start indefinite stream for specific passenger
  --help                     Show this help
  [no args]                  Run 10-minute simulation for all passengers

Examples:
  node continuous_passenger_movement_fixed.js
  node continuous_passenger_movement_fixed.js --quick 1 3
  node continuous_passenger_movement_fixed.js --start +251911233344
    `);
  } else {
    // Run full simulation
    runContinuousSimulation().catch(error => {
      console.error('\n💥 Error:', error);
      process.exit(1);
    });
  }
}

// Export for module usage
module.exports = {
  PASSENGER_PROFILES,
  continuousPassengerStream,
  startPassenger
};
