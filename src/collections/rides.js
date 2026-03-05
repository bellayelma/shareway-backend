// collections/rides.js - Ride History Schema

const RIDE_STATUS = {
  SCHEDULED: 'scheduled',
  CONFIRMED: 'confirmed',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED_BY_DRIVER: 'cancelled_by_driver',
  CANCELLED_BY_PASSENGER: 'cancelled_by_passenger',
  NO_SHOW: 'no_show',
  DISPUTED: 'disputed'
};

// rides collection document structure
{
  rideId: "RIDE_20240315_ABC123",
  
  // Basic Info
  status: "completed",
  rideType: "scheduled", // or "instant"
  createdAt: "2024-03-15T10:00:00Z",
  updatedAt: "2024-03-15T11:30:00Z",
  
  // Participants
  driver: {
    phone: "+251911240957",
    name: "John Driver",
    photoUrl: "https://...",
    rating: 4.8,
    vehicleInfo: {
      type: "Toyota Corolla",
      color: "Silver",
      plate: "AA 12345",
      model: "2022"
    },
    acceptedAt: "2024-03-15T10:05:00Z"
  },
  
  passenger: {
    phone: "+251920121197",
    name: "Jane Passenger",
    photoUrl: "https://...",
    rating: 4.9,
    passengerCount: 2,
    specialRequests: "Wheelchair accessible",
    bookedAt: "2024-03-15T10:00:00Z"
  },
  
  // Trip Details
  trip: {
    scheduledTime: "2024-03-15T10:30:00Z",
    actualPickupTime: "2024-03-15T10:35:00Z",
    actualDropoffTime: "2024-03-15T11:25:00Z",
    
    pickup: {
      name: "Bole International Airport",
      address: "Airport Road, Addis Ababa",
      location: {
        latitude: 8.9778,
        longitude: 38.7993
      }
    },
    
    destination: {
      name: "Meskel Square",
      address: "Meskel Square, Addis Ababa",
      location: {
        latitude: 9.0108,
        longitude: 38.7612
      }
    },
    
    route: {
      distance: 15.3, // km
      duration: 45, // minutes
      polyline: "encoded_polyline_string",
      waypoints: [] // optional stops
    }
  },
  
  // Financial Details
  payment: {
    method: "cash", // or "card", "wallet"
    fare: {
      base: 100,
      distance: 250,
      time: 75,
      surge: 0,
      total: 425,
      currency: "ETB"
    },
    breakdown: {
      distance: 15.3,
      ratePerKm: 16.34,
      timeMinutes: 45,
      ratePerMinute: 1.67
    },
    paidAt: "2024-03-15T11:26:00Z",
    transactionId: "TXN_123456"
  },
  
  // Ratings & Reviews
  feedback: {
    driverRating: 5,
    driverReview: "Very professional and on time",
    passengerRating: 5,
    passengerReview: "Great passenger, punctual",
    driverFeedbackAt: "2024-03-15T11:30:00Z",
    passengerFeedbackAt: "2024-03-15T11:31:00Z"
  },
  
  // History & Audit
  timeline: [
    { event: "scheduled", time: "2024-03-15T10:00:00Z", by: "passenger" },
    { event: "confirmed", time: "2024-03-15T10:05:00Z", by: "driver" },
    { event: "driver_arrived", time: "2024-03-15T10:32:00Z", by: "system" },
    { event: "started", time: "2024-03-15T10:35:00Z", by: "driver" },
    { event: "completed", time: "2024-03-15T11:25:00Z", by: "system" }
  ],
  
  // Support & Issues
  support: {
    reported: false,
    issueType: null,
    resolution: null,
    reportedAt: null
  }
}
