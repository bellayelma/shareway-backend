const { v4: uuidv4 } = require('uuid');

module.exports = {
  // Generate unique IDs
  generateId: (prefix = '') => {
    return `${prefix}${uuidv4()}`;
  },
  
  // Generate match key for deduplication
  generateMatchKey: (driverId, passengerId, timestamp = Date.now()) => {
    const timeWindow = Math.floor(timestamp / 30000);
    return `${driverId}_${passengerId}_${timeWindow}`;
  },
  
  // Calculate Haversine distance
  calculateHaversineDistance: (lat1, lon1, lat2, lon2) => {
    try {
      const R = 6371; // Earth's radius in kilometers
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon/2) * Math.sin(dLon/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      const distance = R * c;
      return Math.round(distance * 1000) / 1000; // Return in km with 3 decimals
    } catch (error) {
      console.error('❌ Error calculating Haversine distance:', error);
      return Infinity;
    }
  },
  
  // Calculate ETA based on distance
  calculateETA: (distanceKm, avgSpeedKph = 30) => {
    const timeHours = distanceKm / avgSpeedKph;
    const timeMinutes = Math.ceil(timeHours * 60);
    return timeMinutes;
  },
  
  // Validate required fields
  validateRequiredFields: (data, requiredFields) => {
    const missing = [];
    requiredFields.forEach(field => {
      if (data[field] === undefined || data[field] === null || data[field] === '') {
        missing.push(field);
      }
    });
    return missing;
  },
  
  // Sanitize user data
  sanitizeUserData: (userData) => {
    const sanitized = { ...userData };
    
    // Remove sensitive fields if they exist
    delete sanitized.password;
    delete sanitized.token;
    delete sanitized.private_key;
    
    return sanitized;
  },
  
  // Parse Firestore timestamp
  parseFirestoreTimestamp: (timestamp) => {
    if (!timestamp) return null;
    if (timestamp.toDate) return timestamp.toDate();
    if (timestamp._seconds) return new Date(timestamp._seconds * 1000);
    if (typeof timestamp === 'string') return new Date(timestamp);
    return null;
  },
  
  // Format date for display
  formatDateTime: (date) => {
    if (!date) return 'N/A';
    const d = new Date(date);
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
};
