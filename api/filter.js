/**
 * Yemot HaMashiach - Audio File Filter & Approval API
 */

export default async function handler(req, res) {
    // הגדרת קידוד נכון כדי שהעברית תעבור בצורה חלקה לימות המשיח
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');

    // איחוד פרמטרים של GET ו-POST
    const params = { ...req.query, ...req.body };

    // 1. משיכת הטוקן שהוגדר בשלוחה
    const YEMOT_TOKEN = params.yemot_token;
    const YEMOT_BASE_URL = 'https://www.call2all.co.il/ym/api/';

    if (!YEMOT_TOKEN) {
        console.error("Missing yemot_token parameter.");
        return sendYemotAction(res, "שגיאת מערכת חסר אסימון התחברות בהגדרות השלוחה");
    }

    try {
        // שלב 2: עיבוד תשובת המשתמש (זיהוי אם אנחנו אחרי תפריט האישור)
        // חיפוש שם המשתנה שמתחיל ב-Approve_
        const approveKey = Object.keys(params).find(key => key.startsWith('Approve_'));

        if (approveKey) {
            return await handleUserSelection(res, params, approveKey, YEMOT_TOKEN, YEMOT_BASE_URL);
        } 
        
        // שלב 1: כניסה למודול (למשל לחיצה על מקש 8 במהלך השמעת קובץ)
        if (params.what && params.ApiExtension) {
            return await handleInitialTrigger(res, params);
        }

        return sendYemotAction(res, "לא התקבל קובץ או נתיב שלוחה תקין משרת ימות המשיח");

    } catch (error) {
        console.error("API Execution Error:", error);
        return sendYemotAction(res, "אירעה שגיאה בעיבוד הבקשה פנו למנהל המערכת");
    }
}

/**
 * שלב 1: זיהוי הקובץ והשמעת תפריט רובוטי
 */
async function handleInitialTrigger(res, params) {
    const { what, ApiExtension } = params;
    
    // זיהוי מקור הקובץ על בסיס הנתיב
    const origin = getFileOrigin(what, ApiExtension);
    
    const ttsOriginText = origin === 'website' 
        ? 'הקובץ הועלה דרך אתר הניהול' 
        : `הקובץ הוקלט בשלוחה ${origin}`;
        
    // בניית טקסט ללא נקודות או מקפים כדי למנוע קריסה בימות המשיח!
    const ttsPrompt = `${ttsOriginText} לאישור הקובץ והעלאתו למערכת הקישו 1 למחיקת הקובץ הקישו 2 לביטול וחזרה הקישו 3`;

    // קידוד הנתיב ב-HEX (רק אותיות ומספרים) למניעת שגיאות במשתנים בימות המשיח
    const encodedWhat = Buffer.from(what).toString('hex');
    const varName = `Approve_${encodedWhat}`;

    // בניית פקודת Read: הקראה רובוטית, ללא שימוש בקיים, מקסימום ומינימום 1, זמן המתנה 7 שניות, חסימת כוכבית ואפס, מקשים מותרים: 1, 2, 3
    const readCommand = `read=t-${ttsPrompt}=${varName},no,1,1,7,No,yes,yes,,1.2.3`;

    console.log(`[Initial Trigger] File: ${what}, Origin: ${origin}. Sending read menu.`);
    return res.status(200).send(readCommand);
}

/**
 * שלב 2: ביצוע פעולה על פי בחירת המשתמש
 */
async function handleUserSelection(res, params, approveKey, token, baseUrl) {
    const action = params[approveKey]; // יכיל 1, 2, או 3
    const encodedWhat = approveKey.replace('Approve_', '');
    const what = Buffer.from(encodedWhat, 'hex').toString('utf-8');
    const ApiExtension = params.ApiExtension;

    console.log(`[User Action] File: ${what}, Action Selected: ${action}`);

    // ביטול וחזרה
    if (action === '3') {
        return sendYemotAction(res, "הפעולה בוטלה");
    }

    // מחיקת הקובץ
    if (action === '2') {
        const deleteSuccess = await executeYemotFileAction(baseUrl, token, 'delete', what);
        if (deleteSuccess) {
            return sendYemotAction(res, "הקובץ נמחק בהצלחה");
        } else {
            return sendYemotAction(res, "שגיאה במחיקת הקובץ");
        }
    }

    // אישור הקובץ והעברה ליעד
    if (action === '1') {
        const origin = getFileOrigin(what, ApiExtension);
        const destination = await getDestinationFromExtIni(baseUrl, token, ApiExtension, origin);

        if (!destination) {
            console.error(`Destination not found for origin: ${origin}`);
            return sendYemotAction(res, `לא הוגדר יעד להעברה עבור מקור ${origin === 'website' ? 'אתר הניהול' : origin}`);
        }

        // וידוא שהשלוחה קיימת, ואם לא - יצירתה אוטומטית!
        await ensureFolderExists(baseUrl, token, destination);

        // ביצוע העברה ליעד
        const targetPath = destination.startsWith('ivr2:') ? destination : `ivr2:${destination.startsWith('/') ? '' : '/'}${destination}`;
        const moveSuccess = await executeYemotFileAction(baseUrl, token, 'move', what, targetPath);

        if (moveSuccess) {
            return sendYemotAction(res, "הקובץ אושר והועבר בהצלחה");
        } else {
            return sendYemotAction(res, "שגיאה בהעברת הקובץ ליעד");
        }
    }

    return sendYemotAction(res, "בחירה לא חוקית");
}

/**
 * חילוץ מקור הקובץ בצורה בטוחה
 */
function getFileOrigin(what, apiExtension) {
    let cleanWhat = what.replace('ivr2:', ''); 
    let ext = apiExtension; 
    
    if (!ext.startsWith('/')) ext = '/' + ext; 
    if (!ext.endsWith('/')) ext = ext + '/';   

    if (cleanWhat.startsWith(ext)) {
        let relativePath = cleanWhat.substring(ext.length); 
        let parts = relativePath.split('/');
        
        if (parts.length === 1) {
            return 'website';
        } else {
            return parts[0]; 
        }
    }
    return 'website';
}

/**
 * קריאת הגדרות custom_route מקובץ ext.ini דרך ה-API של ימות המשיח
 */
async function getDestinationFromExtIni(baseUrl, token, apiExtension, origin) {
    try {
        let ext = apiExtension;
        if (!ext.startsWith('/')) ext = '/' + ext;
        const extIniPath = `ivr2:${ext}ext.ini`;

        const url = `${baseUrl}DownloadFile?token=${encodeURIComponent(token)}&path=${encodeURIComponent(extIniPath)}`;
        
        const response = await fetch(url);
        if (!response.ok) return null;

        const iniText = await response.text();
        const lines = iniText.split('\n');
        
        const searchKey = `custom_route_${origin}`;
        
        for (let line of lines) {
            line = line.trim();
            if (!line || line.startsWith(';')) continue; 
            
            const [key, ...valParts] = line.split('=');
            if (key && key.trim() === searchKey) {
                return valParts.join('=').trim(); 
            }
        }
        
        return null;
    } catch (error) {
        console.error("Error reading ext.ini:", error);
        return null;
    }
}

/**
 * יצירת תיקייה אם אינה קיימת
 */
async function ensureFolderExists(baseUrl, token, dest) {
    let cleanDest = dest.replace('ivr2:', '');
    if (!cleanDest.startsWith('/')) cleanDest = '/' + cleanDest;
    
    const url = `${baseUrl}UpdateExtension?token=${encodeURIComponent(token)}&path=ivr2:${encodeURIComponent(cleanDest)}&type=playfile`;
    try { await fetch(url); } catch (e) { console.error(e); }
}

/**
 * הפעלת פעולות העברה ומחיקה
 */
async function executeYemotFileAction(baseUrl, token, action, what, target = null) {
    try {
        let url = `${baseUrl}FileAction?token=${encodeURIComponent(token)}&action=${encodeURIComponent(action)}&what=${encodeURIComponent(what)}`;
        if (target) url += `&target=${encodeURIComponent(target)}`;

        const response = await fetch(url);
        const data = await response.json();
        return (data.responseStatus === 'OK' && data.success === true);
    } catch (error) {
        console.error(error);
        return false;
    }
}

/**
 * פונקציית עזר להחזרת תשובה קולית וחזרה לתפריט בצורה יציבה
 */
function sendYemotAction(res, message) {
    // .g-. אומר למערכת: נגן את הטקסט, ואז go_to_folder=. (חזור לשלוחה הנוכחית)
    return res.status(200).send(`id_list_message=t-${message}.g-.`);
}
