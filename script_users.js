// ===== GitHub Users + Chips Sync =====
const GH_OWNER  = "genomesylph";
const GH_REPO   = "texas-cowboy";  
const GH_BRANCH = "main";
const GH_PATH   = "users.json";

const RAW_URL = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}/${GH_PATH}`;
const API_URL = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_PATH}`;

// ผู้ใช้ปัจจุบันจาก localStorage
const currentUser = localStorage.getItem("cowboy_current");
let allUsers = {};
let shaLatest = null; // sha ล่าสุดของ users.json
let myToken = null;   // เก็บ token ที่ user กรอกตอนจะบันทึก

// โหลด users.json จาก GitHub
async function loadUsers(){
  const res = await fetch(RAW_URL, { cache:"no-cache" });
  if(!res.ok) throw new Error("โหลด users.json ไม่ได้");
  allUsers = await res.json();
  return allUsers;
}

// ดึง sha ล่าสุดของไฟล์ (เอาไว้ตอน push)
async function fetchSha(){
  const res = await fetch(API_URL);
  if(!res.ok) throw new Error("โหลด sha ไม่ได้");
  const meta = await res.json();
  shaLatest = meta.sha;
}

// อัปเดต users.json กลับขึ้น GitHub
async function saveUsers(){
  if(!myToken) {
    myToken = prompt("ใส่ GitHub Token (repo:contents write)");
    if(!myToken) throw new Error("ไม่มี token");
  }
  await fetchSha();

  const jsonStr = JSON.stringify(allUsers, null, 2);
  const contentB64 = btoa(unescape(encodeURIComponent(jsonStr)));

  const body = {
    message: `update users.json ${new Date().toISOString()}`,
    content: contentB64,
    sha: shaLatest,
    branch: GH_BRANCH
  };

  const res = await fetch(API_URL, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `token ${myToken}`
    },
    body: JSON.stringify(body)
  });
  if(!res.ok) {
    myToken = null; // ถ้า fail ให้ถามใหม่รอบหน้า
    throw new Error("อัป GitHub ไม่สำเร็จ");
  }
  console.log("✅ บันทึก users.json สำเร็จ");
}

// ========== Hook เข้ากับเกม ==========
async function initUser(){
  await loadUsers();
  if(!allUsers[currentUser]){
    alert("ไม่พบผู้เล่นนี้ในระบบ");
    window.location.href = "login.html";
    return;
  }
  chips = allUsers[currentUser].chips; // ใช้ global chips ของเกม
  updateChips();
}

// override updateChips ให้ sync กลับ GitHub
const _updateChips = updateChips;
updateChips = function(){
  _updateChips();
  if(currentUser && allUsers[currentUser]){
    allUsers[currentUser].chips = chips;
    saveUsers().catch(e=>console.error(e));
  }
};

// เริ่มทำงาน
initUser();
