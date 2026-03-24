const admin = require('firebase-admin');
const axios = require('axios');

// Inicialização segura do Firebase via variáveis de ambiente
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
    if (withdrawalData.status !== 'processing' && withdrawalData.status !== 'pending') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Este saque já foi processado.' }) };
    }

    // Cálculo de valores
    const valorBruto = parseFloat(withdrawalData.amount);
    const taxaPlataforma = 0.10;
    const valorTaxa = Number((valorBruto * taxaPlataforma).toFixed(2));
    const valorLiquido = Number((valorBruto - valorTaxa).toFixed(2));

    const evopayToken = process.env.EVOPAY_TOKEN ? process.env.EVOPAY_TOKEN.trim() : '';

    // 1. Verificação de Saldo (Sempre bom garantir)
    console.log('--- VALIDANDO SALDO ANTES DO SAQUE ---');
    const checkBalance = await axios.get('https://pix.evopay.cash/v1/account/balance', {
      headers: { 'API-Key': evopayToken }
    });
    
    if (checkBalance.data.balance < valorLiquido) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ error: `Saldo insuficiente na EvoPay. Saldo: ${checkBalance.data.balance}` }) 
      };
    }

    // 2. Payload de Saque
    const payloadEvoPay = {
      amount: valorLiquido,
      pixKey: withdrawalData.pixKey,
      pixType: withdrawalData.pixType || 'cpf', // Se der erro 400, tente mudar para 'pixKeyType'
      description: `Saque ID ${withdrawId}`
    };

    console.log('Tentando rota de saque: https://pix.evopay.cash/v1/withdraw');

    // TENTATIVA: Usando a primeira URL sugerida
    const evopayResponse = await axios.post('https://pix.evopay.cash/v1/withdraw', payloadEvoPay, {
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
      fee: valorTaxa,
      approvedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const transactionRef = db.collection('users').doc(userId).collection('transactions').doc();
    batch.set(transactionRef, {
      type: 'withdrawal',
      amount: valorBruto,
      netAmount: valorLiquido,
      fee: valorTaxa,
      status: 'completed',
      description: `Saque PIX Enviado`,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await batch.commit();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, message: 'Saque processado!', id: gatewayId })
    };

  } catch (error) {
    console.error('--- ERRO NA OPERAÇÃO ---');
    const status = error.response?.status || 500;
    const errorMsg = error.response?.data?.message || error.response?.data?.error || error.message;
    
    console.error(`Status: ${status}`);
    console.error(`Detalhes: ${JSON.stringify(error.response?.data || errorMsg)}`);

    return {
      statusCode: status,
      headers,
      body: JSON.stringify({ success: false, error: errorMsg })
    };
  }
};
