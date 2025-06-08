// firebase.js

// 从你需要的SDK中导入你需要的函数
import { initializeApp, getApps } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

// 你的Web应用的Firebase配置
// TODO: 将此处替换为你自己的FIREBASE配置

const firebaseConfig = {
    apiKey: "AIzaSyA0YTWHTrWgSo3wmpQwnA547bg5Ly6k6mA",
    authDomain: "smart-idiom-cards-d51dd.firebaseapp.com",
    projectId: "smart-idiom-cards-d51dd",
    storageBucket: "smart-idiom-cards-d51dd.firebasestorage.app",
    messagingSenderId: "562288575215",
    appId: "1:562288575215:web:eb166c59e3be1e57fbd11a"
  };

// 初始化Firebase
let app;
// 检查Firebase应用是否已经被初始化，防止重复初始化
if (!getApps().length) {
  app = initializeApp(firebaseConfig);
} else {
  app = getApps()[0];
}

const db = getFirestore(app);
const auth = getAuth(app);

// 导出db和auth，以便在应用的其他地方使用
export { db, auth };