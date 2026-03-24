import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { Card, CardContent } from '../components/ui/card';
import CheckIn from '../components/CheckIn';
import Roulette from '../components/Roulette';
import { TrendingUp, Users, Wallet, Loader2 } from 'lucide-react';

import { db } from "../firebase/firebase"; 
import { collection, query, where, doc, onSnapshot } from 'firebase/firestore';

// Componente para a animação de contagem fluida
const AnimatedNumber = ({ value }: { value: number }) => {
  const [displayValue, setDisplayValue] = useState(value);
  const previousValue = useRef(value);

  useEffect(() => {
    const start = previousValue.current;
    const end = value;
    if (start === end) return;

    const duration = 1000; 
    const startTime = performance.now();

    const updateNumber = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const easeOut = 1 - Math.pow(1 - progress, 3);
      const current = start + (end - start) * easeOut;
      
      setDisplayValue(current);

      if (progress < 1) {
        requestAnimationFrame(updateNumber);
      } else {
        previousValue.current = end;
      }
    };

    requestAnimationFrame(updateNumber);
    previousValue.current = end;
  }, [value]);

  return <span>R$ {displayValue.toFixed(2)}</span>;
};

export default function HomePage() {
  const { user } = useAuth();
  const [stats, setStats] = useState({ 
    todayEarnings: 0, 
    totalInvites: 0,
    allTimeEarnings: 0,
    currentBalance: 0
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) return;

    // 1. ESCUTADOR DO SALDO (Atualiza na hora que ganha)
    const userRef = doc(db, 'users', user.id);
    const unsubUser = onSnapshot(userRef, (docSnap) => {
      if (docSnap.exists()) {
        setStats(prev => ({ ...prev, currentBalance: Number(docSnap.data().balance || 0) }));
      }
    });

    // 2. ESCUTADOR DA EQUIPE
    const qTeam = query(collection(db, 'users'), where('referredBy', '==', user.id));
    const unsubTeam = onSnapshot(qTeam, (snapshot) => {
      setStats(prev => ({ ...prev, totalInvites: snapshot.size }));
    });

    // 3. ESCUTADOR DAS TRANSAÇÕES (Soma tudo em tempo real)
    const transactionsRef = collection(db, 'users', user.id, 'transactions');
    const unsubTransactions = onSnapshot(transactionsRef, (snapshot) => {
      let todayTotal = 0;
      let grandTotal = 0;
      
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const startOfTodaySeconds = Math.floor(today.getTime() / 1000);

      // Ignora apenas os depósitos na hora de somar os lucros
      const excludeTypes = ['deposit', 'pix_deposit', 'manual_deposit']; 

      snapshot.forEach((doc) => {
        const data = doc.data();
        const amount = Number(data.amount || 0);
        const type = data.type?.toLowerCase() || '';
        
        if (amount > 0 && !excludeTypes.includes(type)) {
          grandTotal += amount;
          
          // Correção do Bug: Se createdAt for null (pendente de envio para o Firebase), 
          // ou se a data for de hoje, ele soma no ganho diário.
          const isToday = !data.createdAt || data.createdAt.seconds >= startOfTodaySeconds;
          
          if (isToday) {
            todayTotal += amount;
          }
        }
      });

      setStats(prev => ({
        ...prev,
        todayEarnings: todayTotal,
        allTimeEarnings: grandTotal
      }));
      
      setLoading(false);
    });

    // Limpa os escutadores quando o usuário sai da tela
    return () => {
      unsubUser();
      unsubTeam();
      unsubTransactions();
    };
  }, [user?.id]);

  if (!user || loading) {
    return <div className="h-screen bg-black flex items-center justify-center"><Loader2 className="animate-spin text-[#22c55e]"/></div>;
  }

  return (
    <div className="space-y-6 pb-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-gray-400 text-sm">Bem-vindo de volta</p>
          <h1 className="text-xl font-bold text-white">{user.email?.split('@')[0]}</h1>
        </div>
        <div className="w-12 h-12 bg-gradient-to-br from-[#22c55e] to-[#16a34a] rounded-full flex items-center justify-center text-white font-bold">
          {user.email?.charAt(0).toUpperCase()}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Card className="bg-[#111111]/80 border-[#1a1a1a]">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="w-4 h-4 text-[#22c55e]" />
              <span className="text-gray-400 text-sm">Ganhos Hoje</span>
            </div>
            <p className="text-2xl font-bold text-[#22c55e]">
              <AnimatedNumber value={stats.todayEarnings} />
            </p>
          </CardContent>
        </Card>

        <Card className="bg-[#111111]/80 border-[#1a1a1a]">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-2">
              <Users className="w-4 h-4 text-[#22c55e]" />
              <span className="text-gray-400 text-sm">Equipe</span>
            </div>
            <p className="text-2xl font-bold text-[#22c55e]">{stats.totalInvites}</p>
          </CardContent>
        </Card>
      </div>

      <Card className="bg-[#111111]/80 border-[#22c55e]/30 shadow-lg shadow-[#22c55e]/5">
        <CardContent className="pt-5 pb-5">
          <div className="flex items-center gap-2 mb-2 text-gray-400 text-sm">
            <Wallet className="w-5 h-5 text-[#22c55e]" /> Saldo Disponível
          </div>
          <p className="text-3xl font-extrabold text-white mb-3">
            <AnimatedNumber value={stats.currentBalance} />
          </p>
          <div className="pt-3 border-t border-[#1a1a1a] flex justify-between text-sm">
            <span className="text-gray-500">Total Ganhos (Geral)</span>
            <span className="text-[#22c55e] font-semibold">
              <AnimatedNumber value={stats.allTimeEarnings} />
            </span>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-[#111111]/80 border-[#1a1a1a]">
        <CardContent className="pt-6">
          {/* O tempo real já resolve tudo, não precisamos forçar a atualização aqui */}
          <CheckIn onCheckInComplete={() => {}} />
        </CardContent>
      </Card>

      <Roulette onSpinComplete={() => {}} />
    </div>
  );
}
