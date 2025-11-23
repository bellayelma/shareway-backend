const calculateRouteSimilarity = (passengerRoute, driverRoute) => {
  if (!passengerRoute || !driverRoute || !Array.isArray(passengerRoute) || !Array.isArray(driverRoute)) {
    return 0;
  }
  
  if (passengerRoute.length === 0 || driverRoute.length === 0) return 0;
  
  const passengerPoints = passengerRoute.length;
  const driverPoints = driverRoute.length;
  const minPoints = Math.min(passengerPoints, driverPoints);
  
  let matchingPoints = 0;
  for (let i = 0; i < minPoints; i++) {
    if (isPointSimilar(passengerRoute[i], driverRoute[i])) {
      matchingPoints++;
    }
  }
  
  return matchingPoints / Math.max(passengerPoints, driverPoints);
};

const isPointSimilar = (point1, point2, threshold = 0.001) => {
  if (!point1 || !point2) return false;
  if (typeof point1.lat === 'undefined' || typeof point2.lat === 'undefined') return false;
  
  const latDiff = Math.abs(point1.lat - point2.lat);
  const lngDiff = Math.abs(point1.lng - point2.lng);
  return latDiff < threshold && lngDiff < threshold;
};

const isLocationAlongRoute = (location, routePoints, maxDistance = 0.5) => {
  if (!location || !routePoints || !Array.isArray(routePoints)) return false;
  if (typeof location.lat === 'undefined') return false;
  
  if (routePoints.length === 0) return false;
  
  for (const point of routePoints) {
    if (!point) continue;
    const distance = calculateDistance(location, point);
    if (distance <= maxDistance) {
      return true;
    }
  }
  return false;
};

const calculateDistance = (point1, point2) => {
  if (!point1 || !point2) return Infinity;
  if (typeof point1.lat === 'undefined' || typeof point2.lat === 'undefined') return Infinity;
  
  const R = 6371;
  const dLat = (point2.lat - point1.lat) * Math.PI / 180;
  const dLng = (point2.lng - point1.lng) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(point1.lat * Math.PI / 180) * Math.cos(point2.lat * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

const generateRouteHash = (pickup, destination) => {
  if (!pickup || !destination) return 'invalid_route';
  if (typeof pickup.lat === 'undefined' || typeof destination.lat === 'undefined') return 'invalid_coordinates';
  
  const pickupRounded = `${Number(pickup.lat).toFixed(3)},${Number(pickup.lng).toFixed(3)}`;
  const destRounded = `${Number(destination.lat).toFixed(3)},${Number(destination.lng).toFixed(3)}`;
  return `${pickupRounded}_${destRounded}`;
};

// Check if driver has capacity for passenger
const hasCapacity = (driver, passengerCount) => {
  const availableSeats = driver.capacity - (driver.currentPassengers || 0);
  return availableSeats >= passengerCount;
};

// Update driver capacity after match
const updateDriverCapacity = async (db, driverId, passengerCount, operation = 'add') => {
  const driverRef = db.collection('active_drivers').doc(driverId);
  const driverDoc = await driverRef.get();
  
  if (!driverDoc.exists) return false;
  
  const driverData = driverDoc.data();
  let currentPassengers = driverData.currentPassengers || 0;
  
  if (operation === 'add') {
    currentPassengers += passengerCount;
  } else if (operation === 'remove') {
    currentPassengers = Math.max(0, currentPassengers - passengerCount);
  }
  
  await driverRef.update({ currentPassengers });
  return true;
};

module.exports = {
  calculateRouteSimilarity,
  isLocationAlongRoute,
  generateRouteHash,
  calculateDistance,
  hasCapacity,
  updateDriverCapacity
};
