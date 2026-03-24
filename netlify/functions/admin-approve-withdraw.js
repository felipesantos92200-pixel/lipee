const admin = require('firebase-admin');
const axios = require('axios');

if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined
      })
    });
  } catch (error) {
    console.error("Erro na inicialização do Firebase:", error);
  }
}

const db = admin.firestore();

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    const expectedToken = process.env.ADMIN_SECRET_TOKEN;

    if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Não autorizado.' }) };
    }

    const { userId, withdrawId } = JSON.parse(event.body);

    const withdrawalRef = db.collection('users').doc(userId).collection('withdrawals').doc(withdrawId);
    const withdrawalDoc = await withdrawalRef.get();

    if (!withdrawalDoc.exists) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Saque não encontrado.' }) };
    }

    const withdrawalData = withdrawalDoc.data();
    
    // Cálculo de valores
    const valorBruto = parseFloat(withdrawalData.amount);
    const taxaPlataforma = 0.10;
    const valorLiquido = Number((valorBruto * 0.90).toFixed(2)); // Garante 2 casas decimais

    const evopayToken = process.env.EVOPAY_TOKEN ? process.env.EVOPAY_TOKEN.trim() : '';

    // 1. Payload Ajustado
    // Adicionei 'pixKeyType' e 'keyType' pois algumas APIs da EvoPay exigem um desses nomes
    const payloadEvoPay = {
      amount: valorLiquido,
      pixKey: withdrawalData.pixKey,
      pixType: withdrawalData.pixType || 'cpf',
      pixKeyType: withdrawalData.pixType || 'cpf', // Campo extra por segurança
      description: `Saque ${withdrawId}`
    };

    // 2. TESTE NA SEGUNDA URL SUGERIDA
    console.log(`Tentando Saque (R$ ${valorLiquido}) em: https://api.evopay.cash/v1/withdraw`);

    const evopayResponse = await axios.post('https://api.evopay.cash/v1/withdraw', payloadEvoPay, {
      headers: { 
        'API-Key': evopayToken,
        'Content-Type': 'application/json'
      }
    });

    const gatewayId = evopayResponse.data?.id || evopayResponse.data?.transactionId || 'N/A';

    // 3. Sucesso: Atualiza Firebase
    const batch = db.batch();
    batch.update(withdrawalRef, {
      status: 'completed',
      gatewayTransactionId: gatewayId,
      netAmount: valorLiquido,
      approvedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const transactionRef = db.collection('users').doc(userId).collection('transactions').doc();
    batch.set(transactionRef, {
      type: 'withdrawal',
      amount: valorBruto,
      status: 'completed',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await batch.commit();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, message: 'Saque Realizado!', id: gatewayId })
    };

  } catch (error) {
    console.error('--- ERRO NA OPERAÇÃO ---');
    const status = error.response?.status || 500;
    const errorData = error.response?.data || {};
    
    console.error(`Status: ${status}`);
    console.error(`Detalhes da EvoPay: ${JSON.stringify(errorData)}`);

    return {
      statusCode: status,
      headers,
      body: JSON.stringify({ 
        success: false, 
        error: errorData.message || "Erro na comunicação com o banco." 
      })
    };
  }
};
