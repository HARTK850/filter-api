/**
 * Yemot HaMashiach - Audio File Filter & Approval API
 * Path: api/filter.js
 */

export default async function handler(req, res) {
    // איחוד פרמטרים של GET ו-POST
    const params = { ...req.query, ...req.body };

    // 1. משיכת הטוקן שהוגדר בימות המשיח (דרך api_add_X=yemot_token=...)
    const YEMOT_TOKEN = params.yemot_token;
    const YEMOT_BASE_URL = 'https://www.call2all.co.il/ym/api/';

    if (!YEMOT_TOKEN) {
        console.error("Missing yemot_token parameter.");
        return sendYemotResponse(res, "t-שגיאת מערכת. חסר אסימון התחברות בהגדרות השלוחה.&go_to_folder=.");
    }

    try {
        // שלב 2: עיבוד תשובת המשתמש (זיהוי אם אנחנו אחרי תפריט האישור)
        // הנתון נשמר בתוך שם משתנה שמתחיל ב-Approve_
        const approveKey = Object.keys(params).find(key => key.startsWith('Approve_'));

        if (approveKey) {
            return await handleUserSelection(res, params, approveKey, YEMOT_TOKEN, YEMOT_BASE_URL);
        } 
        
        // שלב 1: כניסה למודול ממקש ניהול (למשל מקש 8 במהלך השמעת הקובץ)
        if (params.what && params.ApiExtension) {
            return await handleInitialTrigger(res, params);
        }

        return sendYemotResponse(res, "t-שגיאה. לא התקבל קובץ או נתיב שלוחה תקין משרת ימות המשיח.&go_to_folder=.");

    } catch (error) {
        console.error("API Execution Error:", error);
        return sendYemotResponse(res, "t-אירעה שגיאה בעיבוד הבקשה. פנו למנהל המערכת.&go_to_folder=.");
    }
}

/**
 * שלב 1: זיהוי הקובץ והשמעת תפריט רובוטי מותאם
 */
async function handleInitialTrigger(res, params) {
    const { what, ApiExtension } = params;
    
    // זיהוי מקור הקובץ על בסיס הנתיב
    const origin = getFileOrigin(what, ApiExtension);
    
    const ttsOriginText = origin === 'website' 
        ? 'הקובץ הועלה דרך אתר הניהול' 
        : `הקובץ הוקלט בשלוחה ${origin}`;
        
    const ttsPrompt = `t-${ttsOriginText}. t-לאישור הקובץ והעלאתו למערכת הקישו 1. t-למחיקת הקובץ הקישו 2. t-לביטול וחזרה הקישו 3.`;

    // קידוד הנתיב ב-Base64 בתוך שם המשתנה (כדי לשמור אותו לשלב הבא בלי לשבור את המבנה)
    const encodedWhat = Buffer.from(what).toString('base64');
    const varName = `Approve_${encodedWhat}`;

    // בניית פקודת Read לימות המשיח (הקראה רובוטית + קליטת ספרה אחת)
    const readCommand = `read=${ttsPrompt}=${varName},no,1,1,7,No,yes,no`;

    console.log(`[Initial Trigger] File: ${what}, Origin: ${origin}. Sending read menu.`);
    return res.status(200).send(readCommand);
}

/**
 * שלב 2: ביצוע פעולה על פי בחירת המשתמש
 */
async function handleUserSelection(res, params, approveKey, token, baseUrl) {
    const action = params[approveKey]; // יכיל 1, 2, או 3
    const encodedWhat = approveKey.replace('Approve_', '');
    const what = Buffer.from(encodedWhat, 'base64').toString('utf-8');
    const ApiExtension = params.ApiExtension;

    console.log(`[User Action] File: ${what}, Action Selected: ${action}`);

    // ביטול
    if (action === '3') {
        return sendYemotResponse(res, "t-הפעולה בוטלה.&go_to_folder=.");
    }

    // מחיקת הקובץ
    if (action === '2') {
        const deleteSuccess = await executeYemotFileAction(baseUrl, token, 'delete', what);
        if (deleteSuccess) {
            return sendYemotResponse(res, "t-הקובץ נמחק בהצלחה.&go_to_folder=.");
        } else {
            return sendYemotResponse(res, "t-שגיאה במחיקת הקובץ.&go_to_folder=.");
        }
    }

    // אישור הקובץ (העברה ליעד)
    if (action === '1') {
        const origin = getFileOrigin(what, ApiExtension);
        const destination = await getDestinationFromExtIni(baseUrl, token, ApiExtension, origin);

        if (!destination) {
            console.error(`Destination not found for origin: ${origin}`);
            return sendYemotResponse(res, `t-לא הוגדר יעד להעברה עבור מקור ${origin === 'website' ? 'אתר הניהול' : origin}.&go_to_folder=.`);
        }

        // וידוא שהשלוחה קיימת, ואם לא - יצירתה אוטומטית
        await ensureFolderExists(baseUrl, token, destination);

        // ביצוע העברה ליעד
        const targetPath = destination.startsWith('ivr2:') ? destination : `ivr2:${destination.startsWith('/') ? '' : '/'}${destination}`;
        const moveSuccess = await executeYemotFileAction(baseUrl, token, 'move', what, targetPath);

        if (moveSuccess) {
            return sendYemotResponse(res, "t-הקובץ אושר והועבר בהצלחה.&go_to_folder=.");
        } else {
            return sendYemotResponse(res, "t-שגיאה בהעברת הקובץ ליעד.&go_to_folder=.");
        }
    }

    return sendYemotResponse(res, "t-בחירה לא חוקית.&go_to_folder=.");
}

/**
 * חילוץ מקור הקובץ בצורה בטוחה
 */
function getFileOrigin(what, apiExtension) {
    // what example: "ivr2:/9/1/000.wav" or "ivr2:/9/000.wav"
    // apiExtension example: "9" or "/9"

    let cleanWhat = what.replace('ivr2:', ''); 
    let ext = apiExtension; 
    
    // נרמול הוספת סלאשים
    if (!ext.startsWith('/')) ext = '/' + ext; 
    if (!ext.endsWith('/')) ext = ext + '/';   

    if (cleanWhat.startsWith(ext)) {
        let relativePath = cleanWhat.substring(ext.length); 
        let parts = relativePath.split('/');
        
        // אם יש רק את שם הקובץ (ללא תת-תיקייה), הועלה ישירות לאתר/שלוחה הראשית
        if (parts.length === 1) {
            return 'website';
        } else {
            // תחזיר את שם תת-התיקייה הראשונה
            return parts[0]; 
        }
    }
    
    return 'website'; // ברירת מחדל
}

/**
 * קריאת הגדרות custom_route מקובץ ext.ini דרך ה-API של ימות המשיח
 */
async function getDestinationFromExtIni(baseUrl, token, apiExtension, origin) {
    try {
        let ext = apiExtension;
        if (!ext.startsWith('/')) ext = '/' + ext;
        const extIniPath = `ivr2:${ext}/ext.ini`;

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
 * יצירת תיקייה אם אינה קיימת (באמצעות פקודת UpdateExtension)
 */
async function ensureFolderExists(baseUrl, token, dest) {
    let cleanDest = dest.replace('ivr2:', '');
    if (!cleanDest.startsWith('/')) cleanDest = '/' + cleanDest;
    
    const url = `${baseUrl}UpdateExtension?token=${encodeURIComponent(token)}&path=ivr2:${encodeURIComponent(cleanDest)}&type=playfile`;
    
    try {
        await fetch(url); // ימות המשיח תעדכן/תיצור את השלוחה אוטומטית
    } catch (error) {
        console.error('Error ensuring folder exists:', error);
    }
}

/**
 * הפעלת פעולות העברה ומחיקה מול ימות המשיח
 */
async function executeYemotFileAction(baseUrl, token, action, what, target = null) {
    try {
        let url = `${baseUrl}FileAction?token=${encodeURIComponent(token)}&action=${encodeURIComponent(action)}&what=${encodeURIComponent(what)}`;
        if (target) {
            url += `&target=${encodeURIComponent(target)}`;
        }

        const response = await fetch(url);
        const data = await response.json();

        return (data.responseStatus === 'OK' && data.success === true);
    } catch (error) {
        console.error(`Exception during FileAction ${action}:`, error);
        return false;
    }
}

/**
 * פונקציית עזר להחזרת תשובה קולית ושמירה על יציבות
 */
function sendYemotResponse(res, message) {
    return res.status(200).send(`id_list_message=${message}`);
}
