// ========================================
// NETLIFY FUNCTION: Webhook Pagamentos Final (CORRIGIDO)
// ========================================
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
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Método não permitido' };

  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    
    // 1. Identificar a Transação
    const transactionId = body.reference || body.id || (event.queryStringParameters ? event.queryStringParameters.id : null);
    if (!transactionId) return { statusCode: 400, body: JSON.stringify({ error: 'ID ausente' }) };

    // 2. Verificar Status de Pagamento
    const statusCeto = String(body.status).toUpperCase();
    const isPaid = statusCeto === 'PAID' || statusCeto === 'COMPLETED' || body.success === true;

    if (!isPaid) return { statusCode: 200, body: JSON.stringify({ message: 'Aguardando pagamento' }) };

    // 3. Buscar Depósito Global
    const depositRef = db.collection('deposits').doc(transactionId);
    const depositDoc = await depositRef.get();
    
    if (!depositDoc.exists) return { statusCode: 404, body: JSON.stringify({ error: 'Depósito não encontrado' }) };

    const { userId, amount, status: currentStatus, userName } = depositDoc.data();

    if (currentStatus === 'completed' || currentStatus === 'approved') {
      return { statusCode: 200, body: JSON.stringify({ message: 'Já processado' }) };
    }

    const parsedAmount = parseFloat(amount);
    const userRef = db.collection('users').doc(userId);

    // ==========================================
    // TRANSAÇÃO ATÔMICA
    // ==========================================
    await db.runTransaction(async (transaction) => {
      
      const userSnap = await transaction.get(userRef);
      if (!userSnap.exists) throw new Error("Usuário não existe");
      const userData = userSnap.data();

      let ref1Snap = null, ref2Snap = null, ref3Snap = null;
      let ref1Ref = null, ref2Ref = null, ref3Ref = null;

      if (userData.referredBy) {
        ref1Ref = db.collection('users').doc(userData.referredBy);
        ref1Snap = await transaction.get(ref1Ref);
        
        if (ref1Snap.exists && ref1Snap.data().referredBy) {
          ref2Ref = db.collection('users').doc(ref1Snap.data().referredBy);
          ref2Snap = await transaction.get(ref2Ref);

          if (ref2Snap.exists && ref2Snap.data().referredBy) {
            ref3Ref = db.collection('users').doc(ref2Snap.data().referredBy);
            ref3Snap = await transaction.get(ref3Ref);
          }
        }
      }

      // A) Atualizar Depósito
      transaction.update(depositRef, { 
        status: 'completed', 
        paidAt: admin.firestore.FieldValue.serverTimestamp() 
      });

      // B) Atualizar Saldo do Usuário
      transaction.update(userRef, {
        balance: admin.firestore.FieldValue.increment(parsedAmount),
        totalDeposited: admin.firestore.FieldValue.increment(parsedAmount)
      });

      // C) Histórico do Depósito
      const userTransRef = userRef.collection('transactions').doc(transactionId);
      transaction.set(userTransRef, {
        status: 'completed',
        description: 'Depósito via PIX (Confirmado)',
        paidAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      // D) Comissões
      
      // Nível 1 (20%)
      if (ref1Snap?.exists) {
        const bonus1 = parsedAmount * 0.20;
        transaction.update(ref1Ref, {
          balance: admin.firestore.FieldValue.increment(bonus1),
          totalCommissions: admin.firestore.FieldValue.increment(bonus1)
        });
        transaction.set(ref1Ref.collection('transactions').doc(`bonus1_${transactionId}`), {
          amount: bonus1, status: 'completed', type: 'commission',
          level: 1, // <--- ADICIONADO AQUI
          description: `Indicação Nível 1: ${userName || 'Usuário'}`,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      // Nível 2 (5%)
      if (ref2Snap?.exists) {
        const bonus2 = parsedAmount * 0.05;
        transaction.update(ref2Ref, {
          balance: admin.firestore.FieldValue.increment(bonus2),
          totalCommissions: admin.firestore.FieldValue.increment(bonus2)
        });
        transaction.set(ref2Ref.collection('transactions').doc(`bonus2_${transactionId}`), {
          amount: bonus2, status: 'completed', type: 'commission',
          level: 2, // <--- ADICIONADO AQUI
          description: `Indicação Nível 2: ${userName || 'Usuário'}`,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      // Nível 3 (1%)
      if (ref3Snap?.exists) {
        const bonus3 = parsedAmount * 0.01;
        transaction.update(ref3Ref, {
          balance: admin.firestore.FieldValue.increment(bonus3),
          totalCommissions: admin.firestore.FieldValue.increment(bonus3)
        });
        transaction.set(ref3Ref.collection('transactions').doc(`bonus3_${transactionId}`), {
          amount: bonus3, status: 'completed', type: 'commission',
          level: 3, // <--- ADICIONADO AQUI
          description: `Indicação Nível 3: ${userName || 'Usuário'}`,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    });

    return { statusCode: 200, body: JSON.stringify({ success: true }) };

  } catch (error) {
    console.error("Erro no webhook:", error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
