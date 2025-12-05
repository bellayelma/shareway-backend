// Validation middleware
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
  },
  
  // Validate passenger data (added from new requirements)
  validatePassengerData: (req, res, next) => {
    const { userId, name, phone } = req.body;
    
    // Generate userId if missing
    if (!userId) {
      req.body.userId = `passenger_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      console.log(`ℹ️ Generated userId: ${req.body.userId}`);
    }
    
    // Validate required fields
    if (!name || !phone) {
      return res.status(400).json({ 
        success: false,
        error: 'Missing required fields: name and phone are required' 
      });
    }
    
    // Optional: Validate phone format (basic validation)
    if (phone && !/^\+?[\d\s\-\(\)]{10,}$/.test(phone)) {
      return res.status(400).json({
        success: false,
        error: 'Phone number format is invalid'
      });
    }
    
    // Optional: Validate name length
    if (name && name.length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Name must be at least 2 characters long'
      });
    }
    
    next();
  }
};
