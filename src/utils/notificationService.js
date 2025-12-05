// src/services/notificationService.js
let webSocketServer = null;

// Initialize WebSocket server reference
function setWebSocketServer(wss) {
  webSocketServer = wss;
  console.log('✅ WebSocket server reference set in notification service');
}

// Enhanced sendMatchProposals function
async function sendMatchProposals(matchId, driver, passenger) {
  console.log(`📋 Sending match proposal for match: ${matchId}`);
  
  try {
    // Validate userIds before sending
    if (!passenger.userId) {
      console.error(`❌ Cannot send match proposal: Passenger ${passenger.id} has no userId`);
      console.log('Passenger object:', JSON.stringify(passenger, null, 2));
      return false;
    }
    
    if (!driver.userId) {
      console.error(`❌ Cannot send match proposal: Driver ${driver.id} has no userId`);
      console.log('Driver object:', JSON.stringify(driver, null, 2));
      return false;
    }
    
    console.log(`✅ Validated IDs - Driver: ${driver.userId}, Passenger: ${passenger.userId}`);
    
    // Create match data
    const matchData = {
      matchId: matchId,
      driverId: driver.userId,
      driverName: driver.name || driver.displayName || 'Driver',
      passengerId: passenger.userId,
      passengerName: passenger.name || passenger.displayName || 'Passenger',
      pickupName: driver.from || passenger.from || 'Pickup',
      destinationName: driver.to || passenger.to || 'Destination',
      pickupLocation: driver.pickupLocation || passenger.pickupLocation,
      destinationLocation: driver.destinationLocation || passenger.destinationLocation,
      passengerCount: passenger.passengerCount || passenger.count || 1,
      capacity: driver.capacity || 4,
      similarityScore: driver.similarityScore || 85,
      estimatedTime: '5-10 mins',
      estimatedDuration: '15 mins',
      distance: '2.5 km',
      fareAmount: 25.50,
      isScheduled: driver.isScheduled || passenger.isScheduled || false,
      rideType: driver.rideType || passenger.rideType || 'immediate',
      timestamp: new Date().toISOString()
    };
    
    // Use WebSocket server to send proposal
    if (webSocketServer && webSocketServer.sendMatchProposal) {
      const sent = webSocketServer.sendMatchProposal(matchData);
      
      if (sent) {
        console.log(`✅ Match proposal sent successfully via WebSocket`);
        
        // Also send traditional match notification
        const matchSent = webSocketServer.sendMatchToUsers({
          ...matchData,
          type: 'IMMEDIATE_MATCH'
        });
        
        return sent;
      } else {
        console.error(`❌ WebSocket failed to send match proposal`);
        
        // Fallback: Log to database for later notification
        await firestoreService.logFailedNotification({
          matchId,
          driverId: driver.userId,
          passengerId: passenger.userId,
          timestamp: new Date().toISOString(),
          reason: 'WebSocket send failed'
        });
        
        return false;
      }
    } else {
      console.error('❌ WebSocket server not available for notifications');
      return false;
    }
    
  } catch (error) {
    console.error('❌ Error sending match proposals:', error);
    return false;
  }
}

// Other notification functions...
async function sendMatchAccepted(matchData) {
  if (webSocketServer && webSocketServer.sendMatchProposalAccepted) {
    return webSocketServer.sendMatchProposalAccepted(matchData);
  }
  return false;
}

async function sendMatchDeclined(matchData) {
  if (webSocketServer && webSocketServer.sendMatchProposalDeclined) {
    return webSocketServer.sendMatchProposalDeclined(matchData);
  }
  return false;
}

async function sendToUser(userId, message) {
  if (webSocketServer && webSocketServer.sendToUser) {
    return webSocketServer.sendToUser(userId, message);
  }
  return false;
}

module.exports = {
  setWebSocketServer,
  sendMatchProposals,
  sendMatchAccepted,
  sendMatchDeclined,
  sendToUser,
  // ... other notification functions
};
