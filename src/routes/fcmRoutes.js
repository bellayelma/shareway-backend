// routes/fcmRoutes.js
const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

// Initialize Firestore
const db = admin.firestore();
const FCM_TOKENS = 'fcm_tokens';

/**
 * POST /api/fcm/register-token
 * Register FCM token for a user (works even without WebSocket)
 */
router.post('/register-token', async (req, res) => {
  try {
    const { userId, token, deviceInfo } = req.body;
    
    console.log('📱 [FCM API] ========== TOKEN REGISTRATION ==========');
    console.log('📱 [FCM API] User ID:', userId);
    console.log('📱 [FCM API] Token:', token ? token.substring(0, 30) + '...' : 'missing');
    console.log('📱 [FCM API] Device Info:', deviceInfo);
    
    // Validation
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        error: 'userId is required' 
      });
    }
    
    if (!token) {
      return res.status(400).json({ 
        success: false, 
        error: 'token is required' 
      });
    }
    
    // Format phone number consistently
    const formattedUserId = formatPhoneNumber(userId);
    
    // Check if token already exists
    const existingSnapshot = await db
      .collection(FCM_TOKENS)
      .where('userId', '==', formattedUserId)
      .where('token', '==', token)
      .get();
    
    if (!existingSnapshot.empty) {
      // Update existing token
      const doc = existingSnapshot.docs[0];
      await doc.ref.update({
        lastUsed: new Date().toISOString(),
        deviceInfo: deviceInfo || doc.data().deviceInfo,
        active: true,
        updatedAt: new Date().toISOString()
      });
      console.log('✅ [FCM API] Updated existing token for', formattedUserId);
    } else {
      // Create new token
      const tokenData = {
        userId: formattedUserId,
        token: token,
        deviceInfo: deviceInfo || {},
        active: true,
        createdAt: new Date().toISOString(),
        lastUsed: new Date().toISOString(),
        platform: deviceInfo?.platform || 'unknown',
        registeredVia: 'http_api'
      };
      
      await db.collection(FCM_TOKENS).add(tokenData);
      console.log('✅ [FCM API] Created new token for', formattedUserId);
    }
    
    console.log('✅ [FCM API] Token registration successful');
    
    res.json({
      success: true,
      message: 'FCM token registered successfully',
      timestamp: Date.now()
    });
    
  } catch (error) {
    console.error('❌ [FCM API] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/fcm/tokens/:userId
 * Get all tokens for a user (for debugging)
 */
router.get('/tokens/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const formattedUserId = formatPhoneNumber(userId);
    
    const snapshot = await db
      .collection(FCM_TOKENS)
      .where('userId', '==', formattedUserId)
      .where('active', '==', true)
      .get();
    
    const tokens = [];
    snapshot.forEach(doc => {
      tokens.push({
        id: doc.id,
        ...doc.data()
      });
    });
    
    res.json({
      success: true,
      userId: formattedUserId,
      tokens: tokens,
      count: tokens.length
    });
    
  } catch (error) {
    console.error('❌ [FCM API] Error getting tokens:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/fcm/tokens/:userId/:token
 * Remove a token (when user logs out)
 */
router.delete('/tokens/:userId/:token', async (req, res) => {
  try {
    const { userId, token } = req.params;
    const formattedUserId = formatPhoneNumber(userId);
    
    const snapshot = await db
      .collection(FCM_TOKENS)
      .where('userId', '==', formattedUserId)
      .where('token', '==', token)
      .get();
    
    const batch = db.batch();
    snapshot.forEach(doc => {
      batch.update(doc.ref, { 
        active: false,
        removedAt: new Date().toISOString() 
      });
    });
    
    await batch.commit();
    
    res.json({
      success: true,
      message: 'Token deactivated successfully'
    });
    
  } catch (error) {
    console.error('❌ [FCM API] Error removing token:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Helper function to format phone numbers (copy from your WebSocket server)
function formatPhoneNumber(phone) {
  if (!phone) return null;
  phone = phone.toString().trim();
  let digits = phone.replace(/\D/g, '');
  if (!digits.length) return phone;
  if (digits.startsWith('251') && digits.length === 12) return `+${digits}`;
  if (digits.startsWith('09') && digits.length === 10) return `+251${digits.substring(1)}`;
  if (digits.startsWith('9') && digits.length === 9) return `+251${digits}`;
  return phone.startsWith('+') ? phone : `+${phone}`;
}

module.exports = router;
