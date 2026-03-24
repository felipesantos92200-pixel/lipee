// ========================================
// NETLIFY FUNCTION: Verificar Status (Firestore Local)
// ========================================
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (privateKey) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey.replace(/\\n/g, '\n')
      })
    });
  }
}
const db = admin.apps.length ? admin.firestore() : null;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método não permitido' }) };

  try {
    if (!db) throw new Error("Conexão com Banco de Dados falhou.");
    const { transactionId } = event.queryStringParameters;

    if (!transactionId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'transactionId é obrigatório' }) };
    }

    // Busca o depósito no Firebase pelo ID do documento
    const depositDoc = await db.collection('deposits').doc(transactionId).get();

    if (!depositDoc.exists) {
      return { statusCode: 404, headers, body: JSON.stringify({ success: false, error: 'Depósito não encontrado' }) };
    }

    const data = depositDoc.data();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        status: data.status,
        amount: data.amount,
        createdAt: data.createdAt?.toDate(),
        completedAt: data.completedAt?.toDate()
      })
    };

  } catch (error) {
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'Falha ao verificar status interno' }) };
  }
};
