// utils/notificationService.js
const admin = require('firebase-admin');

class NotificationService {
  constructor(db) {
    this.db = db;
  }

  // ✅ FIXED: Send match notification with CORRECT STRUCTURE
  async sendMatchNotification(matchData) {
    try {
      console.log(`📢 Sending match notification for: ${matchData.driverName} ↔ ${matchData.passengerName}`);
      
      // Create notification documents for both users
      const notifications = [
        {
          userId: matchData.driverId,
          type: 'match_proposal',
          title: 'New Ride Match Found!',
          message: `Passenger ${matchData.passengerName} wants to share your ride. Similarity: ${(matchData.similarityScore * 100).toFixed(1)}%`,
          // ✅ ALL DATA NESTED IN 'data' FIELD
          data: {
            matchId: matchData.matchId,
            driverId: matchData.driverId,
            passengerId: matchData.passengerId,
            driverName: matchData.driverName,
            passengerName: matchData.passengerName,
            similarityScore: matchData.similarityScore,
            matchQuality: matchData.matchQuality,
            driverPhotoUrl: null,
            passengerPhotoUrl: null,
            action: 'view_match'
          },
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        },
        {
          userId: matchData.passengerId,
          type: 'match_proposal',
          title: 'Driver Match Found!',
          message: `Driver ${matchData.driverName} is going your way. Similarity: ${(matchData.similarityScore * 100).toFixed(1)}%`,
          // ✅ ALL DATA NESTED IN 'data' FIELD
          data: {
            matchId: matchData.matchId,
            driverId: matchData.driverId,
            passengerId: matchData.passengerId,
            driverName: matchData.driverName,
            passengerName: matchData.passengerName,
            similarityScore: matchData.similarityScore,
            matchQuality: matchData.matchQuality,
            driverPhotoUrl: null,
            passengerPhotoUrl: null,
            action: 'view_match'
          },
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        }
      ];

      // Save notifications to Firestore
      const batch = this.db.batch();
      notifications.forEach(notification => {
        const notificationRef = this.db.collection('notifications').doc();
        batch.set(notificationRef, notification);
      });
      
      await batch.commit();
      
      console.log(`✅ Notifications sent to both users for match ${matchData.matchId}`);
      console.log(`✅ Notification structure: All match data nested in 'data' field`);
      
      // Update match with notification sent status
      await this.db.collection('potential_matches').doc(matchData.matchId).update({
        notificationSent: true,
        notifiedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      return true;
      
    } catch (error) {
      console.error('❌ Error sending match notification:', error);
      return false;
    }
  }

  // Get notifications for a user
  async getUserNotifications(userId, limit = 20) {
    try {
      const snapshot = await this.db.collection('notifications')
        .where('userId', '==', userId)
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .get();
      
      return snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
    } catch (error) {
      console.error('Error getting user notifications:', error);
      return [];
    }
  }

  // Mark notification as read
  async markNotificationAsRead(notificationId) {
    try {
      await this.db.collection('notifications').doc(notificationId).update({
        read: true,
        readAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return true;
    } catch (error) {
      console.error('Error marking notification as read:', error);
      return false;
    }
  }
}

module.exports = NotificationService;
