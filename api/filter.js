/**
 * Yemot HaMashiach - Audio File Filter & Approval API
 * Deployed on Vercel Serverless Functions
 * Path: api/filter.js
 */

export default async function handler(req, res) {
    // תמיכה ב-GET ו-POST - איחוד הפרמטרים לאובייקט אחד
    const params = { ...req.query, ...req.body };

    // משיכת פרמטרי אבטחה ממשתני הסביבה של Vercel
    const YEMOT_TOKEN = process.env.YEMOT_TOKEN;
    const YEMOT_BASE_URL = 'https://www.call2all.co.il/ym/api/';

    if (!YEMOT_TOKEN) {
        console.error("Missing YEMOT_TOKEN environment variable.");
        return sendYemotResponse(res, "t-שגיאת מערכת חמורה. חסר אסימון התחברות.");
    }

    try {
        // שלב 2: תפיסת התשובה מהמשתמש (לאחר בחירה בתפריט הקולי)
        // ה-API שלנו שתל את הנתיב המקודד ב-Base64 בתוך שם המשתנה שמתחיל ב-Approve_
        const approveKey = Object.keys(params).find(key => key.startsWith('Approve_'));

        if (approveKey) {
            return await handleUserSelection(res, params, approveKey, YEMOT_TOKEN, YEMOT_BASE_URL);
        } 
        
        // שלב 1: כניסה ראשונית מהשלוחה - זיהוי הקובץ ובניית תפריט רובוטי (TTS)
        if (params.what && params.ApiExtension) {
            return await handleInitialTrigger(res, params);
        }

        // במקרה שאין פרמטרים תקינים
        return sendYemotResponse(res, "t-שגיאה. לא התקבל קובץ או נתיב שלוחה תקין משרת ימות המשיח.&go_to_folder=.");

    } catch (error) {
        console.error("API Execution Error:", error);
        return sendYemotResponse(res, "t-אירעה שגיאה בעיבוד הבקשה. פנו למנהל המערכת.&go_to_folder=.");
    }
}

/**
 * שלב 1: טיפול בכניסה הראשונית ובניית תפריט בחירה ב-Read
 */
async function handleInitialTrigger(res, params) {
    const { what, ApiExtension } = params;
    
    // זיהוי מקור הקובץ על בסיס הנתיבים
    const origin = getFileOrigin(what, ApiExtension);
    
    // בניית ההודעה הרובוטית ב-TTS
    const ttsOriginText = origin === 'website' 
        ? 'הקובץ הועלה דרך אתר הניהול' 
        : `הקובץ הוקלט בשלוחה ${origin}`;
        
    const ttsPrompt = `t-${ttsOriginText}. לאישור הקובץ והעלאתו למערכת הקישו 1. למחיקת הקובץ הקישו 2. לביטול וחזרה הקישו 3.`;

    // קידוד נתיב הקובץ ב-Base64 כדי להעביר אותו כחלק משם המשתנה (Stateless Pattern)
    const encodedWhat = Buffer.from(what).toString('base64');
    const varName = `Approve_${encodedWhat}`;

    // בניית פקודת Read לימות המשיח
    // read=[השמעה]=[שם משתנה],[שימוש בקיים],[אורך מקס],[אורך מינ],[זמן המתנה],[צורת השמעה],[חסימת כוכבית],[חסימת אפס]
    const readCommand = `read=${ttsPrompt}=${varName},no,1,1,7,No,yes,no`;

    console.log(`[Initial Trigger] File: ${what}, Origin: ${origin}. Sending read menu.`);
    
    // החזרת הפקודה למערכת
    return res.status(200).send(readCommand);
}

/**
 * שלב 2: עיבוד בחירת המשתמש לאחר תפריט ה-Read וביצוע הפעולה מול שרתי ימות המשיח
 */
async function handleUserSelection(res, params, approveKey, token, baseUrl) {
    const action = params[approveKey]; // יכיל 1, 2, או 3
    const encodedWhat = approveKey.replace('Approve_', '');
    const what = Buffer.from(encodedWhat, 'base64').toString('utf-8');
    const ApiExtension = params.ApiExtension;

    console.log(`[User Action] File: ${what}, Action Selected: ${action}`);

    // פעולה 3: ביטול
    if (action === '3') {
        return sendYemotResponse(res, "t-הפעולה בוטלה.&go_to_folder=.");
    }

    // פעולה 2: מחיקה
    if (action === '2') {
        const deleteSuccess = await executeYemotFileAction(baseUrl, token, 'delete', what);
        if (deleteSuccess) {
            return sendYemotResponse(res, "t-הקובץ נמחק בהצלחה.&go_to_folder=.");
        } else {
            return sendYemotResponse(res, "t-שגיאה במחיקת הקובץ.&go_to_folder=.");
        }
    }

    // פעולה 1: אישור והעברה ליעד דינמי
    if (action === '1') {
        const origin = getFileOrigin(what, ApiExtension);
        const destination = await getDestinationFromExtIni(baseUrl, token, ApiExtension, origin);

        if (!destination) {
            console.error(`Destination not found for origin: ${origin}`);
            return sendYemotResponse(res, `t-לא הוגדר יעד להעברה עבור מקור ${origin === 'website' ? 'אתר הניהול' : origin}.&go_to_folder=.`);
        }

        // ביצוע העברה
        const targetPath = destination.startsWith('ivr2:') ? destination : `ivr2:${destination.startsWith('/') ? '' : '/'}${destination}`;
        const moveSuccess = await executeYemotFileAction(baseUrl, token, 'move', what, targetPath);

        if (moveSuccess) {
            return sendYemotResponse(res, "t-הקובץ אושר והועבר בהצלחה.&go_to_folder=.");
        } else {
            return sendYemotResponse(res, "t-שגיאה בהעברת הקובץ ליעד.&go_to_folder=.");
        }
    }

    // אם הוקש משהו אחר
    return sendYemotResponse(res, "t-בחירה לא חוקית.&go_to_folder=.");
}

/**
 * פונקציית עזר: חישוב מקור הקובץ (אתר הניהול או תת-שלוחה)
 */
function getFileOrigin(what, apiExtension) {
    // דוגמה: 
    // ApiExtension = /5
    // what = ivr2:/5/1/000.wav -> מקור 1
    // what = ivr2:/5/000.wav -> מקור website

    const cleanWhat = what.replace('ivr2:', '');
    const extensionPrefix = apiExtension.endsWith('/') ? apiExtension : `${apiExtension}/`;
    
    // מחיקת הקידומת של השלוחה הנוכחית מהנתיב המלא
    const relativePath = cleanWhat.replace(extensionPrefix, '');
    const pathParts = relativePath.split('/');

    // אם יש רק חלק אחד (למשל 000.wav), הקובץ יושב בשלוחה הראשית של מודול הסינון
    if (pathParts.length === 1) {
        return 'website';
    }

    // אם יש יותר מחלק אחד (למשל 1/000.wav), התיקייה הראשונה היא המקור
    return pathParts[0];
}

/**
 * פונקציית עזר: קריאת קובץ ext.ini משרת ימות המשיח וחילוץ נתיב היעד
 */
async function getDestinationFromExtIni(baseUrl, token, apiExtension, origin) {
    try {
        const extIniPath = `ivr2:${apiExtension}/ext.ini`;
        const url = `${baseUrl}DownloadFile?token=${encodeURIComponent(token)}&path=${encodeURIComponent(extIniPath)}`;
        
        const response = await fetch(url);
        if (!response.ok) {
            console.error(`Failed to download ext.ini: ${response.statusText}`);
            return null;
        }

        const iniText = await response.text();
        const lines = iniText.split('\n');
        
        const searchKey = `custom_route_${origin}`;
        
        for (let line of lines) {
            line = line.trim();
            if (!line || line.startsWith(';')) continue; // התעלמות משורות ריקות או הערות
            
            const [key, ...valParts] = line.split('=');
            if (key && key.trim() === searchKey) {
                return valParts.join('=').trim(); // מחזיר את היעד
            }
        }
        
        return null;
    } catch (error) {
        console.error("Error reading ext.ini:", error);
        return null;
    }
}

/**
 * פונקציית עזר: ביצוע פעולות על קבצים (Move/Delete) דרך API ימות המשיח
 */
async function executeYemotFileAction(baseUrl, token, action, what, target = null) {
    try {
        let url = `${baseUrl}FileAction?token=${encodeURIComponent(token)}&action=${encodeURIComponent(action)}&what=${encodeURIComponent(what)}`;
        if (target) {
            url += `&target=${encodeURIComponent(target)}`;
        }

        const response = await fetch(url);
        const data = await response.json();

        if (data.responseStatus === 'OK' && data.success === true) {
            return true;
        } else {
            console.error(`FileAction ${action} failed:`, data);
            return false;
        }
    } catch (error) {
        console.error(`Exception during FileAction ${action}:`, error);
        return false;
    }
}

/**
 * פונקציית עזר: שולחת תגובה אחידה לימות המשיח (ID List Message)
 */
function sendYemotResponse(res, message) {
    return res.status(200).send(`id_list_message=${message}`);
}
