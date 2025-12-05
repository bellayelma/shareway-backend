// Basic validation middleware
module.exports = {
  // Validate required fields
  validateRequiredFields: (requiredFields) => {
    return (req, res, next) => {
      const missing = [];
      requiredFields.forEach(field => {
        if (!req.body[field] || req.body[field] === '') {
          missing.push(field);
        }
      });
      
      if (missing.length > 0) {
        return res.status(400).json({
          success: false,
          error: `Missing required fields: ${missing.join(', ')}`
        });
      }
      
      next();
    };
  },
  
  // Validate user type
  validateUserType: (req, res, next) => {
    const { userType } = req.body;
    
    if (userType && !['driver', 'passenger'].includes(userType)) {
      return res.status(400).json({
        success: false,
        error: 'userType must be either "driver" or "passenger"'
      });
    }
    
    next();
  },
  
  // Validate location data
  validateLocation: (req, res, next) => {
    const { location } = req.body;
    
    if (location) {
      if (!location.latitude || !location.longitude) {
        return res.status(400).json({
          success: false,
          error: 'Location must include latitude and longitude'
        });
      }
      
      if (typeof location.latitude !== 'number' || typeof location.longitude !== 'number') {
        return res.status(400).json({
          success: false,
          error: 'Latitude and longitude must be numbers'
        });
      }
    }
    
    next();
  }
};
