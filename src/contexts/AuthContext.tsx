import React, { createContext, useContext, useState, useEffect } from 'react';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  User as FirebaseUser
} from 'firebase/auth';

import {
  doc,
  setDoc,
  collection,
  query,
  where,
  getDocs,
  onSnapshot,
  serverTimestamp,
  updateDoc,
  increment,
  addDoc
} from 'firebase/firestore';

import { auth, db } from '../firebase/firebase';

// Interface do Usuário sincronizada com o Webhook
interface User {
  id: string;
  name: string;
  email: string;
  balance: number;
  inviteCode: string;
  referredBy?: string | null; 
  totalCommissions: number; // Mudado de totalEarned para totalCommissions
  totalWithdrawn: number;
  spinsAvailable: number;
  role: string;
  createdAt: any;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string, inviteCode?: string) => Promise<void>;
  logout: () => Promise<void>;
  updateBalance: (amount: number) => Promise<void>;
  completeSpin: (prizeAmount: number) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/* =========================
   AUXILIARES DE CONVITE
========================= */

const generateInviteCode = (): string => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
};

const generateUniqueInviteCode = async (): Promise<string> => {
  let code = generateInviteCode();
  const usersRef = collection(db, 'users');
  for (let i = 0; i < 5; i++) {
    const q = query(usersRef, where('inviteCode', '==', code));
    const snapshot = await getDocs(q);
    if (snapshot.empty) return code;
    code = generateInviteCode();
  }
  return code;
};

/* =========================
   PROVIDER PRINCIPAL
========================= */

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    let unsubscribeUser: (() => void) | null = null;

    const unsubscribeAuth = onAuthStateChanged(auth, async (firebaseUser: FirebaseUser | null) => {
      if (!firebaseUser) {
        setUser(null);
        setToken(null);
        if (unsubscribeUser) unsubscribeUser();
        return;
      }

      const userDocRef = doc(db, 'users', firebaseUser.uid);
      unsubscribeUser = onSnapshot(userDocRef, (docSnap) => {
        if (!docSnap.exists()) return;
        const data = docSnap.data();
        setUser({
          id: firebaseUser.uid,
          ...data
        } as User);
      });

      const idToken = await firebaseUser.getIdToken();
      setToken(idToken);
    });

    return () => {
      unsubscribeAuth();
      if (unsubscribeUser) unsubscribeUser();
    };
  }, []);

  /* =========================
      REGISTRO LIMPO (0 REAIS INICIAIS)
  ========================= */

  const register = async (email: string, password: string, name: string, inviteCodeInput?: string) => {
    try {
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);
      const uid = userCredential.user.uid;
      let inviterUid: string | null = null;

      // 1. Verifica se o código de convite existe
      if (inviteCodeInput?.trim()) {
        const q = query(collection(db, 'users'), where('inviteCode', '==', inviteCodeInput.trim().toUpperCase()));
        const snapshot = await getDocs(q);

        if (!snapshot.empty) {
          inviterUid = snapshot.docs[0].id;
          
          // Registra apenas a conexão do convite. 
          // O dinheiro só será dado pelo Webhook quando houver depósito.
          await addDoc(collection(db, 'invites'), {
            createdAt: serverTimestamp(),
            invitedId: uid,
            inviterId: inviterUid,
            status: "pending", 
            level: 1
          });
        }
      }

      const myInviteCode = await generateUniqueInviteCode();

      // 2. Salva o perfil do novo usuário com saldo ZERADO
      await setDoc(doc(db, 'users', uid), {
        name,
        email,
        balance: 0,
        inviteCode: myInviteCode,
        referredBy: inviterUid || null,
        totalCommissions: 0, // Garantindo que começa com 0
        totalWithdrawn: 0,
        spinsAvailable: 1,
        role: 'user',
        createdAt: serverTimestamp()
      });

    } catch (error) {
      console.error("Erro no registro:", error);
      throw error;
    }
  };

  /* =========================
      OUTRAS FUNÇÕES
  ========================= */

  const login = async (email: string, password: string) => {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const idToken = await userCredential.user.getIdToken();
    setToken(idToken);
  };

  const logout = () => firebaseSignOut(auth);

  const updateBalance = async (amount: number) => {
    if (!auth.currentUser) return;
    const userRef = doc(db, 'users', auth.currentUser.uid);
    await updateDoc(userRef, {
      balance: increment(amount)
    });
  };

  const completeSpin = async (prizeAmount: number) => {
    if (!auth.currentUser) return;
    const userRef = doc(db, 'users', auth.currentUser.uid);
    await updateDoc(userRef, {
      spinsAvailable: increment(-1),
      balance: increment(prizeAmount)
    });
  };

  return (
    <AuthContext.Provider value={{ 
      user, token, login, register, logout, 
      updateBalance, completeSpin 
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth deve ser usado dentro de AuthProvider');
  return context;
};
