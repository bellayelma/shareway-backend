const admin = require('firebase-admin');
require('dotenv').config();

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
});

const db = admin.firestore();

async function addTestUsers() {
  // Test Driver
  const testDriver = {
    userId: "driver_001",
    userType: "driver",
    rideType: "immediate",
    status: "searching",
    pickupLocation: { lat: 9.005, lng: 38.763 },
    destinationLocation: { lat: 9.015, lng: 38.773 },
    routePoints: [
      { lat: 9.005, lng: 38.763 },
      { lat: 9.010, lng: 38.768 },
      { lat: 9.015, lng: 38.773 }
    ],
    capacity: 4,
    currentPassengers: 0,
    routeHash: "9.005,38.763_9.015,38.773",
    driverName: "Test Driver",
    vehicleType: "Sedan",
    createdAt: new Date()
  };

  // Test Passenger
  const testPassenger = {
    userId: "passenger_001", 
    userType: "passenger",
    rideType: "immediate",
    status: "searching",
    pickupLocation: { lat: 9.006, lng: 38.764 },
    destinationLocation: { lat: 9.016, lng: 38.774 },
    passengerCount: 2,
    maxWalkDistance: 0.5,
    routeHash: "9.006,38.764_9.016,38.774",
    passengerName: "Test Passenger",
    createdAt: new Date()
  };

  await db.collection('active_drivers').doc(testDriver.userId).set(testDriver);
  await db.collection('active_passengers').doc(testPassenger.userId).set(testPassenger);
  
  console.log('Test users added successfully!');
}

addTestUsers().catch(console.error);
