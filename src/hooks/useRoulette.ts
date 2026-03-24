import { useState, useEffect } from 'react';
import { collection, query, where, getDocs, addDoc, serverTimestamp, doc, updateDoc, increment } from 'firebase/firestore';
import { db } from '../firebase/firebase';
import { useAuth } from '../contexts/AuthContext';

// Probabilidades: $1/$5/$10 frequentes, $15/$20 raros, $35/$50/$100 = 0%
const PRIZES = [
  { value: 1, weight: 40 },
  { value: 5, weight: 35 },
  { value: 10, weight: 20 },
  { value: 15, weight: 3 },
  { value: 20, weight: 2 },
  { value: 35, weight: 0 },
  { value: 50, weight: 0 },
  { value: 100, weight: 0 }
];

export function useRoulette() {
  const { user } = useAuth();
  const [canSpin, setCanSpin] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }

    checkCanSpin();
  }, [user]);

  const checkCanSpin = async () => {
    if (!user) return;

    try {
      const today = new Date().toISOString().split('T')[0];
      const spinsRef = collection(db, 'users', user.id, 'rouletteSpins');
      const q = query(spinsRef, where('spinDate', '==', today));
      const snapshot = await getDocs(q);

      setCanSpin(snapshot.empty);
    } catch (error) {
      console.error('Error checking roulette status:', error);
    } finally {
      setLoading(false);
    }
  };

  const spin = async (): Promise<{ success: boolean; prize?: number }> => {
    if (!user || !canSpin) {
      return { success: false };
    }

    try {
      // Calcular prêmio baseado em probabilidades
      const totalWeight = PRIZES.reduce((sum, p) => sum + p.weight, 0);
      let random = Math.random() * totalWeight;
      let prize = 1;

      for (const p of PRIZES) {
        random -= p.weight;
        if (random <= 0) {
          prize = p.value;
          break;
        }
      }

      const today = new Date().toISOString().split('T')[0];

      // Registrar giro
      await addDoc(collection(db, 'users', user.id, 'rouletteSpins'), {
        prize,
        spinDate: today,
        createdAt: serverTimestamp()
      });

      // Adicionar prêmio ao saldo
      const userRef = doc(db, 'users', user.id);
      await updateDoc(userRef, {
        balance: increment(prize),
        totalEarned: increment(prize)
      });

      // Registrar transação
      await addDoc(collection(db, 'users', user.id, 'transactions'), {
        type: 'roulette',
        amount: prize,
        status: 'completed',
        description: 'Prêmio da roleta',
        createdAt: serverTimestamp()
      });

      setCanSpin(false);

      return { success: true, prize };
    } catch (error) {
      console.error('Error spinning roulette:', error);
      return { success: false };
    }
  };

  return {
    canSpin,
    loading,
    spin,
    prizes: PRIZES
  };
}
