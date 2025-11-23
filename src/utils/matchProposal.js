const admin = require('firebase-admin');

const createMatchProposal = async (db, match, type) => {
  try {
    const matchId = `${match.driverId}_${match.passengerId}_${Date.now()}`;
    
    const matchData = {
      ...match,
      matchId: matchId,
      type: type,
      status: 'proposed',
      driverResponse: null,
      passengerResponse: null,
      passengerCount: match.passengerData.passengerCount || 1,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 2 * 60000))
    };
    
    await db.collection('ride_matches').doc(matchId).set(matchData);
    
    // Send notification to driver
    await db.collection('notifications').add({
      userId: match.driverId,
      type: 'match_proposal',
      title: type === 'immediate' ? 'New Ride Match' : 'New Scheduled Ride Match',
      body: `Found ${match.passengerData.passengerCount || 1} passenger(s) along your route with ${(match.similarity * 100).toFixed(0)}% match`,
      data: {
        matchId: matchId,
        passengerId: match.passengerId,
        passengerData: match.passengerData,
        type: type,
        passengerCount: match.passengerData.passengerCount || 1
      },
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`Match proposal created: ${matchId} for ${match.passengerData.passengerCount || 1} passenger(s)`);
    return matchId;
  } catch (error) {
    console.error('Error creating match proposal:', error);
    throw error;
  }
};

module.exports = { createMatchProposal };
