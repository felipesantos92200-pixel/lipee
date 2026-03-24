const admin = require('firebase-admin');
const axios = require('axios');

// 1. Inicialização Segura do Firebase Admin
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
    // 2. Autenticação de Segurança (Token do Admin)
    const authHeader = event.headers.authorization || event.headers.Authorization;
    const expectedToken = process.env.ADMIN_SECRET_TOKEN;

    if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Não autorizado. Token de Admin inválido.' }) };
    }

    const { userId, withdrawId } = JSON.parse(event.body);

    if (!userId || !withdrawId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'ID de usuário ou saque ausente.' }) };
    }

    // 3. Busca o documento de saque
    const withdrawalRef = db.collection('users').doc(userId).collection('withdrawals').doc(withdrawId);
    const withdrawalDoc = await withdrawalRef.get();

    if (!withdrawalDoc.exists) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Saque não encontrado.' }) };
    }

    const withdrawalData = withdrawalDoc.data();

    if (withdrawalData.status !== 'processing' && withdrawalData.status !== 'pending') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Este saque já foi processado anteriormente.' }) };
    }

    // 4. Cálculo de Taxas
    const valorBruto = parseFloat(withdrawalData.amount);
    const taxaPlataforma = 0.10;
    const valorTaxa = Number((valorBruto * taxaPlataforma).toFixed(2));
    const valorLiquido = Number((valorBruto - valorTaxa).toFixed(2));

    // 5. Preparação e Envio para a EvoPay
    const evopayToken = process.env.EVOPAY_TOKEN ? process.env.EVOPAY_TOKEN.trim() : '';
    
    // ==========================================
    // INÍCIO DO DEBUG DE AUTENTICAÇÃO
    // ==========================================
    console.log('--- DIAGNÓSTICO DO TOKEN EVOPAY ---');
    console.log(`1. Status do Token no Servidor: ${evopayToken ? 'ENCONTRADO' : 'VAZIO / NÃO ENCONTRADO'}`);
    console.log(`2. Tamanho do Token: ${evopayToken.length} caracteres`);
    if (evopayToken.length > 0) {
      console.log(`3. O Token começa com: ${evopayToken.substring(0, 5)}...`);
    } else {
      console.error('ERRO CRÍTICO: A variável EVOPAY_TOKEN não está configurada no painel de hospedagem!');
    }
    console.log('-----------------------------------');
    // ==========================================

    const payloadEvoPay = {
      amount: valorLiquido,
      pixKey: withdrawalData.pixKey,
      pixType: withdrawalData.pixType || 'cpf',
      description: `Saque Monety - ID ${withdrawId}`
    };

    console.log('Enviando para EvoPay:', payloadEvoPay);

    const configRequest = {
      headers: { 
        'API-Key': evopayToken,
        'Content-Type': 'application/json'
      }
    };

    console.log('Headers configurados (Oculto por segurança):', { ...configRequest.headers, 'API-Key': '***' });

    // Tentativa de envio
    const evopayResponse = await axios.post('https://api.evopay.cash/v1/withdraw', payloadEvoPay, configRequest);

    const gatewayId = evopayResponse.data?.id || evopayResponse.data?.transactionId || 'N/A';

    // 6. Atualização no Firestore (Sucesso)
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
      description: `Saque PIX Aprovado (-10% taxa)`,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await batch.commit();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        success: true, 
        message: 'Saque aprovado e enviado!', 
        enviado: valorLiquido 
      })
    };

  } catch (error) {
    console.error('--- ERRO CRÍTICO NA REQUISIÇÃO EVOPAY ---');
    const errorMsg = error.response?.data?.message || error.message;
    console.error('Mensagem:', errorMsg);

    if (error.response) {
      console.error('Status HTTP:', error.response.status);
      console.error('Dados completos do Erro EvoPay:', JSON.stringify(error.response.data));
      console.error('URL tentada:', error.response.config?.url);
    }
    console.error('------------------------------------------');

    return {
      statusCode: error.response?.status || 500,
      headers,
      body: JSON.stringify({ 
        success: false, 
        error: errorMsg,
        details: error.response?.data || null
      })
    };
  }
};
