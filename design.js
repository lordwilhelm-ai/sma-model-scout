import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getFirestore, collection, addDoc, Timestamp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBxry90zexnjiHIjVv_QluPlPWcqfxWb6Q",
  authDomain: "sma-model-scout.firebaseapp.com",
  projectId: "sma-model-scout",
  storageBucket: "sma-model-scout.firebasestorage.app",
  messagingSenderId: "786081868543",
  appId: "1:786081868543:web:5805a21ac5dab4c799faca",
  measurementId: "G-10LWV01GZE"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const form = document.querySelector("#designForm");

form.addEventListener("submit", async (e) => {

e.preventDefault();

const btn = form.querySelector("button");
btn.textContent = "Submitting...";
btn.disabled = true;

const data = new FormData(form);

const payload = {
name: data.get("name"),
phone: data.get("phone"),
email: data.get("email"),
designType: data.get("type"),
deadline: data.get("deadline"),
budget: data.get("budget"),
description: data.get("description"),
status: "pending",
createdAt: Timestamp.fromDate(new Date())
};

try{

await addDoc(collection(db,"designRequests"),payload);

alert("Request submitted successfully");

form.reset();

}catch(err){

alert("Submission failed");

}

btn.textContent = "Submit Design Request";
btn.disabled = false;

});
