// app/page.tsx
'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { db } from '../firebase'; 
import { collection, addDoc, getDocs, query, orderBy, serverTimestamp, Timestamp, doc, deleteDoc, updateDoc } from 'firebase/firestore';
import { Sun, Moon, Save, LoaderCircle, LayoutList, Inbox, X, BrainCircuit, BotMessageSquare, Trash2, Search, Pencil, GraduationCap, BarChart2, Sparkles } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { GoogleGenerativeAI } from "@google/generative-ai";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// --- Data Structures ---
interface Card { id: string; term: string; meaning: string; example: string; context: string; translation: string; srsLevel: number; dueDate: Timestamp; }
interface Deck { id: string; title: string; cards: Card[]; createdAt: Timestamp; }
interface Notification { message: string; type: 'success' | 'error'; }
type AiProvider = 'gemini' | 'deepseek';

// --- Helper Functions & Constants ---
const formatTimestamp = (timestamp: Timestamp): string => {
  if (!timestamp || !timestamp.toDate) return '未知时间';
  return timestamp.toDate().toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
};
const SRS_INTERVALS_DAYS = [1, 3, 7, 14, 30, 90, 180, 365];
const STATS_COLORS = ["#ef4444", "#f97316", "#eab308", "#84cc16", "#22c55e", "#10b981", "#06b6d4", "#3b82f6", "#8b5cf6"];

// --- AI Setup ---
const geminiApiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY || "";
const deepseekApiKey = process.env.NEXT_PUBLIC_DEEPSEEK_API_KEY || "";
const genAI = geminiApiKey ? new GoogleGenerativeAI(geminiApiKey) : null;
const geminiModel = genAI ? genAI.getGenerativeModel({ model: "gemini-1.5-flash"}) : null;

export default function HomePage() {
  // --- State Management ---
  const [inputText, setInputText] = useState('');
  const [activeCards, setActiveCards] = useState<Card[]>([]);
  const [decks, setDecks] = useState<Deck[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isParsing, setIsParsing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [notification, setNotification] = useState<Notification | null>(null);
  const [flippedStates, setFlippedStates] = useState<{[key: string]: boolean}>({});
  const [theme, setTheme] = useState('light');
  const [activeDeckId, setActiveDeckId] = useState<string | null>(null);
  const [hasMounted, setHasMounted] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingDeck, setEditingDeck] = useState<Deck | null>(null);
  const [reviewSession, setReviewSession] = useState<{deck: Deck; queue: Card[]; currentIndex: number; isFlipped: boolean} | null>(null);
  const [aiProvider, setAiProvider] = useState<AiProvider>('gemini');
  const [aiResponses, setAiResponses] = useState<{[key: string]: {loading: boolean; response: string}}>({});

  // --- Effects ---
  useEffect(() => { setHasMounted(true) }, []);

  useEffect(() => {
    const fetchDecks = async () => {
      setIsLoading(true);
      try {
        const q = query(collection(db, "decks"), orderBy("createdAt", "desc"));
        const querySnapshot = await getDocs(q);
        const fetchedDecks = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Deck));
        setDecks(fetchedDecks);
      } catch (err) {
        console.error("获取卡组失败:", err);
        setNotification({ message: "无法从云端加载卡组", type: 'error' });
      } finally {
        setIsLoading(false);
      }
    };
    fetchDecks();
  }, []);

  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  // --- Memoized Calculations ---
  const filteredDecks = useMemo(() => {
    if (!searchTerm) return decks;
    const lowercasedTerm = searchTerm.toLowerCase();
    return decks.filter(deck => 
      deck.title.toLowerCase().includes(lowercasedTerm) || 
      deck.cards.some(card => card.term.toLowerCase().includes(lowercasedTerm))
    );
  }, [decks, searchTerm]);
  
  const learningStats = useMemo(() => {
    const stats = Array(SRS_INTERVALS_DAYS.length + 1).fill(0);
    decks.forEach(deck => {
      deck.cards.forEach(card => {
        const level = card.srsLevel || 0;
        stats[level] = (stats[level] || 0) + 1;
      });
    });
    return stats.map((count, index) => ({ name: `等级 ${index}`, count }));
  }, [decks]);

  // --- Core & Helper Functions ---
  const handleParseText = () => {
    setIsParsing(true);
    setActiveCards([]);
    setFlippedStates({});
    setAiResponses({});
    try {
      // FIX: Use const instead of let
      const tempActiveCards: Omit<Card, 'id' | 'srsLevel' | 'dueDate'>[] = [];
      const complexSectionIndex = inputText.indexOf('重要俚语/习惯用语/短语');
      if (complexSectionIndex > -1) {
        let complexText = inputText.substring(complexSectionIndex);
        const simpleSectionMarkerIndex = complexText.indexOf('简单常见表达');
        if (simpleSectionMarkerIndex > -1) complexText = complexText.substring(0, simpleSectionMarkerIndex);
        const blocks = complexText.split(/\n(?=[^\n]+?\s+意思解释：)/).slice(1);
        const complexCards = blocks.map(block => {
          const term = block.match(/^(.+?)\n/)?.[1].trim() || '未找到术语';
          const meaning = block.match(/意思解释：\s*([\s\S]*?)(?=\n在文中的句子：|\n简要文化背景或用法说明：)/)?.[1].trim() || '';
          const example = block.match(/在文中的句子：\s*([\s\S]*?)(?=\n简要文化背景或用法说明：|\n翻译这句话的意思：)/)?.[1].trim() || '';
          const context = block.match(/简要文化背景或用法说明：\s*([\s\S]*?)(?=\n翻译这句话的意思：)/)?.[1].trim() || '';
          const translation = block.match(/翻译这句话的意思：\s*([\s\S]*)/)?.[1]?.trim() || '';
          return { term, meaning, example, context, translation };
        }).filter(card => card.term !== '未找到术语' && card.meaning);
        tempActiveCards.push(...complexCards);
      }
      const simpleSectionIndex = inputText.indexOf('简单常见表达');
      if (simpleSectionIndex > -1) {
        const simpleText = inputText.substring(simpleSectionIndex);
        const lines = simpleText.split('\n').slice(1).filter(line => line.trim() !== '' && line.includes(' - '));
        const simpleCards = lines.map(line => {
          const parts = line.split(/ - (.+)/);
          if (parts.length < 2) return null;
          return { term: parts[0].trim(), meaning: parts[1].trim(), example: '', context: '', translation: '' };
        }).filter(Boolean);
        tempActiveCards.push(...simpleCards as Omit<Card, 'id'|'srsLevel'|'dueDate'>[]);
      }
      const allCards = tempActiveCards.map(c => ({...c, id: crypto.randomUUID(), srsLevel: 0, dueDate: Timestamp.now()}))
      if (allCards.length > 0) {
        setNotification({ message: `成功生成 ${allCards.length} 张预览卡片！`, type: 'success' });
        setActiveCards(allCards);
        setActiveDeckId(null);
      } else {
        setNotification({ message: '解析失败，未提取到卡片。', type: 'error' });
      }
    } catch (e) {
      setNotification({ message: '解析时发生错误。', type: 'error' });
      console.error(e);
    } finally {
      setIsParsing(false);
    }
  };

  const handleSaveDeck = async () => {
    if (activeCards.length === 0) { setNotification({ message: "没有可以保存的卡片！", type: 'error' }); return; }
    setIsSaving(true);
    // FIX: Use const instead of let
    const title = inputText.match(/^标题：\s*(.*)/m)?.[1] || `卡组 - ${new Date().toLocaleString('zh-CN')}`;
    try {
      const newDeckData = { title, cards: activeCards, createdAt: serverTimestamp() };
      const docRef = await addDoc(collection(db, "decks"), newDeckData);
      const newDeck = { id: docRef.id, ...newDeckData, createdAt: Timestamp.now() } as Deck;
      setDecks(prevDecks => [newDeck, ...prevDecks]);
      setNotification({ message: `卡组 "${title}" 保存成功！`, type: 'success' });
      loadDeck(newDeck);
    } catch (err) {
      console.error("保存失败: ", err);
      setNotification({ message: "保存失败，请检查控制台错误。", type: 'error' });
    } finally {
      setIsSaving(false);
    }
  };

  const loadDeck = (deck: Deck) => {
    setActiveCards(deck.cards);
    setActiveDeckId(deck.id);
    setFlippedStates({});
    setAiResponses({});
    const inputSection = document.getElementById('input-section');
    if (inputSection) inputSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  
  const clearActiveDeck = () => { setActiveCards([]); setActiveDeckId(null); setInputText(''); setAiResponses({}); };
  
  const handleDeleteDeck = async (deckId: string, deckTitle: string, e: React.MouseEvent) => {
    e.stopPropagation(); 
    if (window.confirm(`您确定要永久删除卡组 "${deckTitle}" 吗？此操作无法撤销。`)) {
      try {
        await deleteDoc(doc(db, "decks", deckId));
        setDecks(prevDecks => prevDecks.filter(deck => deck.id !== deckId));
        if (activeDeckId === deckId) clearActiveDeck();
        setNotification({ message: '卡组已删除', type: 'success' });
      } catch (err) {
        console.error("删除失败: ", err);
        setNotification({ message: "删除失败，请重试。", type: 'error' });
      }
    }
  };

  const openEditModal = (deck: Deck, e: React.MouseEvent) => { e.stopPropagation(); setEditingDeck(JSON.parse(JSON.stringify(deck))); setIsEditModalOpen(true); };
  const closeEditModal = () => { setIsEditModalOpen(false); setEditingDeck(null); };
  // FIX: Provide a more specific type for 'value' instead of any
  const handleEditingDeckChange = (field: string, value: string, cardIndex?: number) => {
    if (!editingDeck) return;
    if (cardIndex !== undefined) {
        const updatedCards = [...editingDeck.cards];
        updatedCards[cardIndex] = { ...updatedCards[cardIndex], [field]: value };
        setEditingDeck({ ...editingDeck, cards: updatedCards });
    } else {
        setEditingDeck({ ...editingDeck, [field]: value });
    }
  };
  const handleSaveChanges = async () => {
    if (!editingDeck) return;
    const deckRef = doc(db, "decks", editingDeck.id);
    // FIX: Remove unused 'id' variable
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
const { id: _, ...dataToSave } = editingDeck;
    try {
        await updateDoc(deckRef, dataToSave);
        setDecks(prevDecks => prevDecks.map(d => d.id === editingDeck.id ? editingDeck : d));
        if(activeDeckId === editingDeck.id) setActiveCards(editingDeck.cards);
        setNotification({ message: "卡组已成功更新！", type: 'success' });
        closeEditModal();
    } catch (err) {
        console.error("更新失败:", err);
        setNotification({ message: "更新失败，请重试。", type: 'error' });
    }
  };

  const getDueCards = useCallback((deck: Deck) => {
    const now = new Date();
    return deck.cards.filter(card => card.dueDate && card.dueDate.toDate() <= now);
  }, []);

  const startReviewSession = (deck: Deck, e: React.MouseEvent) => {
    e.stopPropagation();
    const dueCards = getDueCards(deck);
    if (dueCards.length === 0) { setNotification({ message: "太棒了！这个卡组今天没有需要复习的卡片。", type: 'success' }); return; }
    const shuffledQueue = dueCards.sort(() => Math.random() - 0.5);
    setReviewSession({ deck, queue: shuffledQueue, currentIndex: 0, isFlipped: false });
  };

  const handleReviewAnswer = async (answer: 'again' | 'good' | 'easy') => {
    if (!reviewSession) return;
    const { deck, queue, currentIndex } = reviewSession;
    const cardToUpdate = queue[currentIndex];
    let newSrsLevel = cardToUpdate.srsLevel || 0;
    switch (answer) {
      case 'again': newSrsLevel = 0; break;
      case 'good': newSrsLevel++; break;
      case 'easy': newSrsLevel += 2; break;
    }
    const intervalDays = SRS_INTERVALS_DAYS[Math.min(newSrsLevel, SRS_INTERVALS_DAYS.length - 1)];
    const newDueDate = new Date();
    if (answer === 'again') newDueDate.setMinutes(newDueDate.getMinutes() + 10);
    else newDueDate.setDate(newDueDate.getDate() + intervalDays);
    const updatedCard = { ...cardToUpdate, srsLevel: newSrsLevel, dueDate: Timestamp.fromDate(newDueDate) };
    const updatedCards = deck.cards.map(c => c.id === updatedCard.id ? updatedCard : c);
    const updatedDeck = { ...deck, cards: updatedCards };
    await updateDoc(doc(db, "decks", deck.id), { cards: updatedCards });
    setDecks(prevDecks => prevDecks.map(d => d.id === updatedDeck.id ? updatedDeck : d));
    if (currentIndex + 1 < queue.length) {
      setReviewSession(prev => prev ? { ...prev, currentIndex: prev.currentIndex + 1, isFlipped: false } : null);
    } else {
      setReviewSession(null);
      setNotification({ message: "恭喜！已完成本次复习！", type: 'success' });
    }
  };
  
  // FIX: Provide a more specific type for 'err' instead of any
  const getAiHelp = async (card: Card) => {
    setAiResponses(prev => ({...prev, [card.id]: { loading: true, response: ''}}));
    try {
      const prompt = `For the English term "${card.term}" which means "${card.meaning}", provide 3 diverse and natural example sentences.`;
      let text = '';
      if (aiProvider === 'gemini' && geminiModel) {
        const result = await geminiModel.generateContent(prompt);
        text = await result.response.text();
      } else if (aiProvider === 'deepseek' && deepseekApiKey) {
        const response = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${deepseekApiKey}` },
          body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: prompt }], stream: false })
        });
        if (!response.ok) throw new Error(`DeepSeek API error: ${response.statusText}`);
        const data = await response.json();
        text = data.choices[0].message.content;
      } else {
        throw new Error("Selected AI provider is not configured. Please check your .env.local file.");
      }
      setAiResponses(prev => ({...prev, [card.id]: { loading: false, response: text }}));
    } catch(err) {
      const errorMessage = err instanceof Error ? err.message : "An unknown error occurred.";
      console.error("AI Assistant Error:", err);
      setAiResponses(prev => ({...prev, [card.id]: { loading: false, response: `AI 助教暂时无法连接: ${errorMessage}` }}));
    }
  };

  if (!hasMounted) {
    return <div className="flex justify-center items-center min-h-screen bg-slate-50 dark:bg-slate-900"><LoaderCircle size={48} className="animate-spin text-blue-500" /></div>;
  }
  
  const AiProviderToggle = () => (
    <div className="flex items-center gap-2 rounded-full bg-slate-200 dark:bg-slate-700 p-1">
      <button onClick={() => setAiProvider('gemini')} disabled={!geminiApiKey} className={`px-3 py-1 text-sm rounded-full transition-colors ${aiProvider === 'gemini' ? 'bg-white dark:bg-slate-900 shadow' : 'opacity-70'} disabled:opacity-30 disabled:cursor-not-allowed`}>Gemini</button>
      <button onClick={() => setAiProvider('deepseek')} disabled={!deepseekApiKey} className={`px-3 py-1 text-sm rounded-full transition-colors ${aiProvider === 'deepseek' ? 'bg-white dark:bg-slate-900 shadow' : 'opacity-70'} disabled:opacity-30 disabled:cursor-not-allowed`}>DeepSeek</button>
    </div>
  );

  return (
    <div className={theme}>
      {reviewSession && (
        <div className="fixed inset-0 bg-slate-900 z-50 flex flex-col items-center justify-center p-4">
          <div className="text-white absolute top-5 left-5 text-sm">复习中: {reviewSession.deck.title}</div>
          <div className="text-white absolute top-5 right-5 text-sm">进度: {reviewSession.currentIndex + 1} / {reviewSession.queue.length}</div>
          <div className="w-full max-w-2xl h-96 perspective-1000" onClick={() => setReviewSession(prev => prev ? {...prev, isFlipped: true} : null)}>
            <div className={`w-full h-full relative transform-style-3d transition-transform duration-700 ${reviewSession.isFlipped ? 'rotate-y-180' : ''}`}>
              <div className="absolute w-full h-full backface-hidden bg-white dark:bg-slate-800 rounded-2xl flex justify-center items-center p-8"><h3 className="text-4xl font-bold text-center">{reviewSession.queue[reviewSession.currentIndex].term}</h3></div>
              <div className="absolute w-full h-full backface-hidden bg-slate-100 dark:bg-slate-700 rounded-2xl p-6 overflow-y-auto transform rotate-y-180 text-sm">
                <div className="space-y-3">
                  <p><strong className="font-semibold">释义:</strong> {reviewSession.queue[reviewSession.currentIndex].meaning}</p>
                  {reviewSession.queue[reviewSession.currentIndex].example && <p className="bg-slate-200 dark:bg-slate-600 p-2 rounded"><strong className="font-semibold">例句:</strong> <em className="italic">{reviewSession.queue[reviewSession.currentIndex].example}</em></p>}
                  {reviewSession.queue[reviewSession.currentIndex].context && <p><strong className="font-semibold">用法:</strong> {reviewSession.queue[reviewSession.currentIndex].context}</p>}
                  {reviewSession.queue[reviewSession.currentIndex].translation && <p><strong className="font-semibold">翻译:</strong> {reviewSession.queue[reviewSession.currentIndex].translation}</p>}
                </div>
              </div>
            </div>
          </div>
          {reviewSession.isFlipped && (
            <div className="mt-8 grid grid-cols-3 gap-4 w-full max-w-2xl animate-fade-in">
              <button onClick={() => handleReviewAnswer('again')} className="p-4 rounded-lg bg-red-500 text-white font-semibold hover:bg-red-600 transition-colors">忘记了<br/><span className="text-xs font-normal">(10分钟后)</span></button>
              <button onClick={() => handleReviewAnswer('good')} className="p-4 rounded-lg bg-blue-500 text-white font-semibold hover:bg-blue-600 transition-colors">还行<br/><span className="text-xs font-normal">(下次: {SRS_INTERVALS_DAYS[Math.min((reviewSession.queue[reviewSession.currentIndex].srsLevel || 0) + 1, SRS_INTERVALS_DAYS.length - 1)]}天后)</span></button>
              <button onClick={() => handleReviewAnswer('easy')} className="p-4 rounded-lg bg-green-500 text-white font-semibold hover:bg-green-600 transition-colors">太简单<br/><span className="text-xs font-normal">(下次: {SRS_INTERVALS_DAYS[Math.min((reviewSession.queue[reviewSession.currentIndex].srsLevel || 0) + 2, SRS_INTERVALS_DAYS.length - 1)]}天后)</span></button>
            </div>
          )}
          <button onClick={() => setReviewSession(null)} className="absolute bottom-5 text-slate-400 hover:text-white transition-colors">结束复习</button>
        </div>
      )}

      <main className={`min-h-screen flex flex-col items-center p-4 sm:p-8 bg-slate-50 dark:bg-slate-900 text-slate-800 dark:text-slate-200 transition-colors duration-300 ${reviewSession ? 'blur-sm' : ''}`}>
        {notification && ( <div className={`fixed top-5 right-5 z-50 p-4 rounded-lg shadow-lg text-white ${notification.type === 'success' ? 'bg-green-500' : 'bg-red-500'} animate-fade-in-down`}>{notification.message}</div> )}
        <div id="app-container" className="w-full max-w-5xl">
          <header className="flex flex-wrap justify-between items-center mb-8 gap-4">
            <h1 className="text-3xl sm:text-4xl font-bold text-slate-900 dark:text-white flex items-center gap-3"><BrainCircuit size={36} className="text-blue-500"/>智能术语卡片</h1>
            <div className="flex items-center gap-4">
              <AiProviderToggle />
              <button onClick={() => setTheme(prev => (prev === 'light' ? 'dark' : 'light'))} className="p-2 rounded-full hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors">{theme === 'light' ? <Moon size={24} /> : <Sun size={24} />}</button>
            </div>
          </header>

          <section className="mb-12">
             <h2 className="text-3xl font-bold mb-6 flex items-center gap-2"><BarChart2/> 学习总览</h2>
             <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl shadow-lg h-80">
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={learningStats} margin={{ top: 5, right: 20, left: -10, bottom: 5 }}>
                        <XAxis dataKey="name" stroke={theme === 'dark' ? '#94a3b8' : '#64748b'} fontSize={12} />
                        <YAxis stroke={theme === 'dark' ? '#94a3b8' : '#64748b'} fontSize={12} allowDecimals={false} />
                        <Tooltip cursor={{fill: 'rgba(100, 116, 139, 0.1)'}} contentStyle={{backgroundColor: theme === 'dark' ? '#1e293b' : 'white', borderRadius: '0.5rem', border: '1px solid #334155'}}/>
                        <Bar dataKey="count">
                            {learningStats.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={STATS_COLORS[index % STATS_COLORS.length]} />
                            ))}
                        </Bar>
                    </BarChart>
                </ResponsiveContainer>
             </div>
          </section>
          
          <section id="input-section" className="bg-white dark:bg-slate-800 p-6 rounded-2xl shadow-lg mb-12">
            <textarea value={inputText} onChange={(e) => setInputText(e.target.value)} placeholder="在此粘贴您的学习笔记全文，包括“标题：”和“重要俚语/习惯用语/短语”..." className="w-full h-60 p-4 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 bg-slate-50 dark:bg-slate-700 transition-all"/>
            <div className="flex flex-col sm:flex-row gap-2 mt-4">
              <button onClick={handleParseText} disabled={isParsing} className="flex-1 bg-blue-600 text-white font-semibold py-3 px-4 rounded-lg hover:bg-blue-700 disabled:bg-slate-400 transition-colors flex justify-center items-center">{isParsing ? <LoaderCircle className="animate-spin" /> : '1. 生成预览卡片'}</button>
              <button onClick={handleSaveDeck} disabled={isSaving || activeCards.length === 0} className="flex-1 bg-green-600 text-white font-semibold py-3 px-4 rounded-lg hover:bg-green-700 disabled:bg-slate-400 transition-colors flex justify-center items-center gap-2">{isSaving ? <LoaderCircle className="animate-spin" /> : <Save />}2. 保存到云端</button>
            </div>
          </section>

          {activeCards.length > 0 && (
            <section>
                <div className="flex justify-between items-center mb-6"><h2 className="text-3xl font-bold flex items-center gap-2"><BotMessageSquare/> 当前卡组</h2><button onClick={clearActiveDeck} className="text-sm text-slate-500 hover:text-red-500 flex items-center gap-1 transition-colors"><X size={16}/> 清除预览</button></div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {activeCards.map((card) => (
                    <div key={card.id} className="perspective-1000 min-h-[20rem]" onClick={() => setFlippedStates(prev => ({ ...prev, [card.id]: !prev[card.id] }))}>
                        <div className={`w-full h-full relative rounded-xl shadow-lg transform-style-3d transition-transform duration-700 cursor-pointer ${flippedStates[card.id] ? 'rotate-y-180' : ''}`}>
                            <div className="absolute w-full h-full backface-hidden bg-white dark:bg-slate-800 border-l-4 border-blue-500 rounded-xl flex flex-col justify-center items-center p-6 text-center"><h3 className="text-2xl font-bold">{card.term}</h3><p className="text-slate-500 dark:text-slate-400 mt-4 text-sm">（点击查看详情）</p></div>
                            <div className="absolute w-full h-full backface-hidden bg-slate-100 dark:bg-slate-700 rounded-xl p-4 flex flex-col transform rotate-y-180 text-sm">
                               <div className="space-y-2 overflow-y-auto pr-2 flex-grow">
                                  {card.meaning && <p><strong className="font-semibold">释义:</strong> {card.meaning}</p>}
                                  {card.example && <p className="bg-slate-200 dark:bg-slate-600 p-2 rounded"><strong className="font-semibold">例句:</strong> <em className="italic">{card.example}</em></p>}
                                  {card.context && <p><strong className="font-semibold">用法:</strong> {card.context}</p>}
                                  {card.translation && <p><strong className="font-semibold">翻译:</strong> {card.translation}</p>}
                               </div>
                               <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-600 flex-shrink-0">
                                  <button onClick={(e) => { e.stopPropagation(); getAiHelp(card); }} disabled={aiResponses[card.id]?.loading} className="w-full flex items-center justify-center gap-2 text-sm text-blue-500 hover:text-blue-400 font-semibold disabled:cursor-not-allowed disabled:opacity-50">
                                  {aiResponses[card.id]?.loading ? <LoaderCircle size={16} className="animate-spin" /> : <Sparkles size={16} />}
                                  AI 提供更多例句
                                  </button>
                                  {aiResponses[card.id] && !aiResponses[card.id]?.loading && (
                                     <div className="mt-2 text-xs text-slate-600 dark:text-slate-300 bg-slate-200 dark:bg-slate-600/50 p-2 rounded max-h-48 overflow-y-auto">
                                        <article className="prose prose-sm dark:prose-invert max-w-none">
                                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                                {aiResponses[card.id].response}
                                            </ReactMarkdown>
                                        </article>
                                     </div>
                                  )}
                               </div>
                            </div>
                        </div>
                    </div>
                ))}
                </div>
            </section>
          )}

          <section className="w-full mt-16">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4"><h2 className="text-3xl font-bold border-b-2 sm:border-b-0 border-blue-500 pb-2 sm:pb-0 flex items-center gap-2 flex-shrink-0"><LayoutList /> 我的云端卡组</h2><div className="relative w-full sm:w-72"><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={20} /><input type="text" placeholder="搜索标题或术语..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="w-full pl-10 pr-4 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 focus:ring-2 focus:ring-blue-500"/></div></div>
            {isLoading ? (<div className="flex justify-center items-center p-8"><LoaderCircle size={32} className="animate-spin text-blue-500" /></div>) : decks.length > 0 ? (filteredDecks.length > 0 ? (<div className="space-y-3">{filteredDecks.map(deck => {const dueCardsCount = getDueCards(deck).length; return (<div key={deck.id} onClick={() => loadDeck(deck)} className={`bg-white dark:bg-slate-800 p-4 rounded-lg shadow-md hover:shadow-xl hover:scale-[1.02] cursor-pointer transition-all flex flex-col sm:flex-row justify-between sm:items-center gap-4 group ${activeDeckId === deck.id ? 'ring-2 ring-blue-500' : ''}`}><div><p className="font-semibold text-lg text-blue-600 dark:text-blue-400">{deck.title}</p><p className="text-sm text-slate-500">{deck.cards.length} 张卡片</p></div><div className="flex items-center gap-2 self-end sm:self-center"><span className="text-sm text-slate-400 hidden lg:block">{formatTimestamp(deck.createdAt)}</span><button onClick={(e) => startReviewSession(deck, e)} disabled={dueCardsCount === 0} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:bg-slate-400 disabled:cursor-not-allowed transition-all text-sm"><GraduationCap size={16} />复习 ({dueCardsCount})</button><button onClick={(e) => openEditModal(deck, e)} className="p-2 rounded-full bg-slate-100 dark:bg-slate-700 text-slate-500 hover:bg-blue-500 hover:text-white transition-all opacity-0 group-hover:opacity-100"><Pencil size={16} /></button><button onClick={(e) => handleDeleteDeck(deck.id, deck.title, e)} className="p-2 rounded-full bg-slate-100 dark:bg-slate-700 text-slate-500 hover:bg-red-500 hover:text-white transition-all opacity-0 group-hover:opacity-100"><Trash2 size={16} /></button></div></div>)})}</div>) : (<div className="text-center p-8 bg-slate-100 dark:bg-slate-800 rounded-lg"><p className="text-slate-500">找不到匹配的卡组。</p><p className="text-slate-400 text-sm mt-1">请尝试更换搜索关键词。</p></div>)) : (<div className="text-center p-8 bg-slate-100 dark:bg-slate-800 rounded-lg"><Inbox size={48} className="mx-auto text-slate-400 mb-4" /><p className="text-slate-500">您的云端仓库是空的。</p><p className="text-slate-400 text-sm mt-1">请先生成卡片，然后点击“保存到云端”。</p></div>)}
          </section>

          {isEditModalOpen && editingDeck && (
            <div className="fixed inset-0 bg-black bg-opacity-60 z-40 flex justify-center items-center p-4" onClick={closeEditModal}><div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}><header className="p-4 border-b border-slate-200 dark:border-slate-700 flex justify-between items-center flex-shrink-0"><h2 className="text-xl font-bold">编辑卡组</h2><button onClick={closeEditModal} className="p-1 rounded-full hover:bg-slate-200 dark:hover:bg-slate-600"><X /></button></header><main className="p-6 overflow-y-auto flex-grow"><div className="mb-6"><label className="block text-sm font-bold mb-2" htmlFor="deckTitle">卡组标题</label><input id="deckTitle" type="text" value={editingDeck.title} onChange={e => handleEditingDeckChange('title', e.target.value)} className="w-full p-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-slate-50 dark:bg-slate-700"/></div><h3 className="text-lg font-semibold mb-4 border-b border-slate-200 dark:border-slate-700 pb-2">卡片内容</h3><div className="space-y-6">{editingDeck.cards.map((card, index) => (<div key={card.id} className="p-4 rounded-lg bg-slate-50 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-700"><div className="grid grid-cols-1 md:grid-cols-2 gap-4"><div><label className="block text-xs font-semibold mb-1">术语</label><textarea value={card.term} onChange={e => handleEditingDeckChange('term', e.target.value, index)} className="w-full p-2 text-sm border rounded bg-white dark:bg-slate-600 border-slate-300 dark:border-slate-500"/></div><div><label className="block text-xs font-semibold mb-1">释义</label><textarea value={card.meaning} onChange={e => handleEditingDeckChange('meaning', e.target.value, index)} rows={3} className="w-full p-2 text-sm border rounded bg-white dark:bg-slate-600 border-slate-300 dark:border-slate-500"/></div><div className="md:col-span-2"><label className="block text-xs font-semibold mb-1">例句</label><textarea value={card.example} onChange={e => handleEditingDeckChange('example', e.target.value, index)} rows={2} className="w-full p-2 text-sm border rounded bg-white dark:bg-slate-600 border-slate-300 dark:border-slate-500"/></div><div><label className="block text-xs font-semibold mb-1">用法</label><textarea value={card.context} onChange={e => handleEditingDeckChange('context', e.target.value, index)} rows={4} className="w-full p-2 text-sm border rounded bg-white dark:bg-slate-600 border-slate-300 dark:border-slate-500"/></div><div><label className="block text-xs font-semibold mb-1">翻译</label><textarea value={card.translation} onChange={e => handleEditingDeckChange('translation', e.target.value, index)} rows={4} className="w-full p-2 text-sm border rounded bg-white dark:bg-slate-600 border-slate-300 dark:border-slate-500"/></div></div></div>))}</div></main><footer className="p-4 border-t border-slate-200 dark:border-slate-700 flex justify-end gap-2 flex-shrink-0"><button onClick={closeEditModal} className="px-4 py-2 rounded-lg bg-slate-200 dark:bg-slate-600 hover:bg-slate-300 dark:hover:bg-slate-500">取消</button><button onClick={handleSaveChanges} className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700">保存更改</button></footer></div></div>
          )}
        </div>
      </main>
    </div>
  );
}