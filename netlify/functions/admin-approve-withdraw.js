const admin = require('firebase-admin');
const axios = require('axios');

// Inicialização segura do Firebase Admin
try {
  if (!admin.apps.length) {
    const serviceAccount = {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Corrige quebras de linha na chave privada
      privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
    };

    if (!serviceAccount.projectId) console.error("❌ ERRO: FIREBASE_PROJECT_ID não encontrado!");
    if (!serviceAccount.clientEmail) console.error("❌ ERRO: FIREBASE_CLIENT_EMAIL não encontrado!");
    if (!serviceAccount.privateKey) console.error("❌ ERRO: FIREBASE_PRIVATE_KEY não encontrada!");

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }
} catch (e) {
  console.error("Falha crítica na inicialização do Firebase:", e.message);
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
    // 1. Verificação de Token Admin (Segurança da Função)
    const authHeader = event.headers.authorization || event.headers.Authorization;
    const expectedToken = process.env.ADMIN_SECRET_TOKEN;

    if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Não autorizado. Verifique o Token de Admin.' }) };
    }

    const { userId, withdrawId } = JSON.parse(event.body);

    if (!userId || !withdrawId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'ID de usuário ou saque ausente.' }) };
    }

    // 2. Busca o saque no Firestore
    const withdrawalRef = db.collection('users').doc(userId).collection('withdrawals').doc(withdrawId);
    const withdrawalDoc = await withdrawalRef.get();

    if (!withdrawalDoc.exists) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Saque não encontrado.' }) };
    }

    const withdrawalData = withdrawalDoc.data();

    // Validação de status
    if (withdrawalData.status !== 'processing' && withdrawalData.status !== 'pending') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Este saque já foi processado anteriormente.' }) };
    }

    // 3. Cálculos de Taxas (10% de desconto)
    const valorBruto = parseFloat(withdrawalData.amount);
    const taxaPlataforma = 0.10; // 10%
    const valorTaxa = Number((valorBruto * taxaPlataforma).toFixed(2));
    const valorLiquido = Number((valorBruto - valorTaxa).toFixed(2));

    // 4. Chamada para EvoPay
    // O .trim() remove espaços em branco acidentais no começo ou fim do token
    const evopayToken = process.env.EVOPAY_TOKEN ? process.env.EVOPAY_TOKEN.trim() : '';
    
    const payloadEvoPay = {
      amount: valorLiquido,
      pixKey: withdrawalData.pixKey,
      pixType: withdrawalData.pixType || 'cpf',
      description: `Saque Monety - ID ${withdrawId}`
    };

    console.log('Enviando para EvoPay:', payloadEvoPay);

    // URL api.evopay.cash conforme documentação
    const evopayResponse = await axios.post('https://api.evopay.cash/v1/withdraw', payloadEvoPay, {
      headers: { 
        'API-Key': evopayToken,
        'Content-Type': 'application/json'
      }
    });

    const gatewayId = evopayResponse.data?.id || evopayResponse.data?.transactionId || 'N/A';

    // 5. Atualização no Firestore (Sucesso)
    const batch = db.batch();

    // Atualiza o documento do saque
    batch.update(withdrawalRef, {
      status: 'completed',
      gatewayTransactionId: gatewayId,
      netAmount: valorLiquido,
      fee: valorTaxa,
      approvedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Cria o registro no histórico de transações
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
    console.error('ERRO CRÍTICO NA FUNÇÃO:');
    const errorMsg = error.response?.data?.message || error.message;
    console.error(errorMsg);

    // Logs detalhados em caso de erro na EvoPay
    if (error.response) {
      console.error('Dados do Erro EvoPay:', JSON.stringify(error.response.data));
      console.error('Status do Erro EvoPay:', error.response.status);
    }

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
