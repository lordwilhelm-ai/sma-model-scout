import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://shtzagoeuhqdthgzvmjx.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNodHphZ29ldWhxZHRoZ3p2bWp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUxMDYyNjMsImV4cCI6MjEwMDY4MjI2M30.ChyQ1hAxsyitWRVXgcMOa8ztuI6WB3oKUhciXgguYyk";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const form = document.querySelector("#designForm");

form.addEventListener("submit", async (e) => {

e.preventDefault();

const btn = form.querySelector("button");
btn.textContent = "Submitting...";
btn.disabled = true;

const data = new FormData(form);

const row = {
full_name: data.get("name"),
phone: data.get("phone"),
email: data.get("email"),
design_type: data.get("type"),
deadline: data.get("deadline"),
budget: data.get("budget"),
description: data.get("description"),
status: "pending"
};

try{

const { error } = await supabase.from("design_requests").insert(row);
if(error) throw error;

alert("Request submitted successfully");

form.reset();

}catch(err){

console.error(err);
alert("Submission failed");

}

btn.textContent = "Submit Design Request";
btn.disabled = false;

});
