const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    })
  });
}

const db = admin.firestore();

exports.handler = async (event) => {
  try {
    const { userId } = event.queryStringParameters || {};

    if (!userId) {
      return { 
        statusCode: 400, 
        body: JSON.stringify({ error: 'userId é obrigatório' }) 
      };
    }

    // Define o início do dia de hoje (00:00:00)
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startTimestamp = admin.firestore.Timestamp.fromDate(startOfDay);

    // 1. Ganhos de Hoje (Busca na coleção 'deposits' que vimos no print)
    const depositsQuery = await db.collection('deposits')
      .where('userId', '==', userId)
      .where('status', '==', 'completed')
      .where('createdAt', '>=', startTimestamp)
      .get();

    let todayEarnings = 0;
    depositsQuery.forEach(doc => {
      const data = doc.data();
      // Soma o campo 'amount' que aparece no seu print
      todayEarnings += Number(data.amount || 0);
    });

    // 2. Convidados de Hoje (Novos usuários que este user indicou hoje)
    const invitesQuery = await db.collection('users')
      .where('referredBy', '==', userId)
      .where('createdAt', '>=', startTimestamp)
      .get();

    return {
      statusCode: 200,
      headers: { 
        'Content-Type': 'application/json', 
        'Access-Control-Allow-Origin': '*' 
      },
      body: JSON.stringify({
        todayEarnings: todayEarnings,
        newInvites: invitesQuery.size
      })
    };
  } catch (error) {
    console.error("Erro na função stats:", error);
    return { 
      statusCode: 500, 
      body: JSON.stringify({ error: error.message }) 
    };
  }
};
