import { GoogleGenAI, Type } from "@google/genai";
import { CabinetItem, ProjectSpecs, CabinetType } from "../types";

// Using process.env.API_KEY as strictly requested
const getAI = () => new GoogleGenAI({ apiKey: process.env.API_KEY });

// gemini-2.0-flash-exp is the current state-of-the-art free experimental model for Vision/PDF
const MODEL_NAME = 'gemini-2.5-flash-lite';

const SYSTEM_INSTRUCTION = `
You are a FAST cabinet code extraction specialist. Your ONLY job: Extract cabinet codes and basic info.

SPEED RULES:
1. Scan document QUICKLY for alphanumeric codes (W3030, B15, VDB27AH-3, etc.)
2. Skip long descriptions - just grab: CODE, QTY, TYPE
3. Ignore everything that's NOT a cabinet (appliances, sinks, hardware, page numbers)

CABINET CODE PATTERNS (extract these):
- W#### = Wall cabinet (e.g., W3030, W2436)
- B## or B### = Base cabinet (e.g., B15, B18, B36)
- VDB## = Vanity drawer base
- SB## = Sink base
- T## or U## = Tall/Utility cabinet
- F# = Filler
- DP, RP, EP = Panels (Dishwasher/Refrigerator/End)

SKIP (not cabinets):
- Appliances: Fridge, Range, Dishwasher, Microwave, Oven
- Plumbing: Sink bowls, Faucets
- Hardware: Hinges, Pulls, Knobs
- Text: "Page 1", "Total", "Summary"

OUTPUT FORMAT:
- code: EXACT code from document
- normalizedCode: Remove -L, -R suffixes only (keep -3, -4 for drawers)
- qty: number
- type: Base/Wall/Tall/Filler/Panel/Accessory
- description: SHORT (max 5 words)
- width/height/depth: Extract from code if possible (W3030 = 30" wide, 30" high)

WORK FAST. Extract ALL cabinet codes. Be accurate.
`;

// Helper to clean and parse JSON resiliently
function safeJSONParse(text: string): any {
    if (!text) return { items: [], specs: {} };

    // Remove code blocks
    let clean = text.replace(/```json/g, '').replace(/```/g, '').trim();

    try {
        return JSON.parse(clean);
    } catch (e) {
        console.warn("JSON Parse Error. Attempting auto-repair...", e);

        try {
            // Try to extract valid JSON object
            const start = clean.indexOf('{');
            const end = clean.lastIndexOf('}');

            if (start !== -1 && end !== -1) {
                let jsonStr = clean.substring(start, end + 1);

                // Try to fix truncated arrays by closing them
                // Look for incomplete array at the end
                const lastOpenBracket = jsonStr.lastIndexOf('[');
                const lastCloseBracket = jsonStr.lastIndexOf(']');

                if (lastOpenBracket > lastCloseBracket) {
                    // Array wasn't closed, try to close it
                    console.warn("Detected unclosed array, attempting to close...");
                    // Remove trailing comma if exists
                    jsonStr = jsonStr.replace(/,\s*$/, '');
                    // Find the last complete object and truncate there
                    const lastCompleteObject = jsonStr.lastIndexOf('}');
                    if (lastCompleteObject > lastOpenBracket) {
                        jsonStr = jsonStr.substring(0, lastCompleteObject + 1) + ']}';
                    }
                }

                return JSON.parse(jsonStr);
            }

            console.error("Could not find valid JSON boundaries");
            return { items: [], specs: {} };
        } catch (repairError) {
            console.error("JSON Repair Failed:", repairError);
            console.error("First 500 chars:", clean.substring(0, 500));
            console.error("Last 500 chars:", clean.substring(clean.length - 500));
            return { items: [], specs: {} };
        }
    }
}

// Helper to strip Data URI prefix
function cleanBase64(data: string): string {
    if (data.includes(',')) {
        return data.split(',')[1];
    }
    return data;
}

export async function analyzePlan(file: File, nkbaRulesBase64?: string): Promise<{
    specs: ProjectSpecs,
    items: CabinetItem[]
}> {
    const base64Data = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(cleanBase64(reader.result as string));
        reader.readAsDataURL(file);
    });

    let mimeType = file.type;
    if (!mimeType || mimeType === '') {
        if (file.name.toLowerCase().endsWith('.pdf')) mimeType = 'application/pdf';
        else if (file.name.toLowerCase().endsWith('.png')) mimeType = 'image/png';
        else if (file.name.toLowerCase().endsWith('.jpg') || file.name.toLowerCase().endsWith('.jpeg')) mimeType = 'image/jpeg';
        else mimeType = 'application/pdf';
    }

    try {
        const ai = getAI();

        const contentsParts: any[] = [
            {
                inlineData: {
                    mimeType: mimeType,
                    data: base64Data
                }
            },
            { text: `SCAN FAST: Extract ALL cabinet codes (W####, B##, VDB##, SB##, etc.). Skip appliances, sinks, hardware. Max 50 items. GO!` }
        ];

        if (nkbaRulesBase64) {
            contentsParts.push({
                inlineData: {
                    mimeType: 'application/pdf',
                    data: cleanBase64(nkbaRulesBase64)
                }
            });
            contentsParts.push({ text: "Reference these NKBA codes to distinguish valid cabinets from appliances." });
        }

        const response = await ai.models.generateContent({
            model: MODEL_NAME,
            contents: { parts: contentsParts },
            config: {
                systemInstruction: SYSTEM_INSTRUCTION,
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        specs: {
                            type: Type.OBJECT,
                            properties: {
                                manufacturer: { type: Type.STRING, description: "Manufacturer name" },
                                doorStyle: { type: Type.STRING, description: "Door style" },
                                finish: { type: Type.STRING, description: "Finish color" },
                                construction: { type: Type.STRING, description: "Construction specs" },
                                notes: { type: Type.STRING, description: "Notes" }
                            }
                        },
                        items: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    code: { type: Type.STRING, description: "The Exact Product Code (e.g. VDB27AH-3)" },
                                    normalizedCode: { type: Type.STRING, description: "NKBA equivalent code" },
                                    qty: { type: Type.NUMBER },
                                    type: { type: Type.STRING, description: "Base, Wall, Tall, Filler, Panel, Accessory" },
                                    description: { type: Type.STRING },
                                    width: { type: Type.NUMBER },
                                    height: { type: Type.NUMBER },
                                    depth: { type: Type.NUMBER },
                                    extractedPrice: { type: Type.NUMBER },
                                    modifications: {
                                        type: Type.ARRAY,
                                        items: {
                                            type: Type.OBJECT,
                                            properties: {
                                                description: { type: Type.STRING, description: "e.g. Finish End Left" },
                                                price: { type: Type.NUMBER }
                                            }
                                        }
                                    },
                                    notes: { type: Type.STRING }
                                },
                                required: ["code", "qty", "type", "description"]
                            }
                        }
                    },
                    required: ["items", "specs"]
                },
                temperature: 0.3, // Optimized for speed while maintaining accuracy
                maxOutputTokens: 8000, // Reduced to prevent truncation issues
            }
        });

        const result = safeJSONParse(response.text || "{}");
        const rawItems = Array.isArray(result?.items) ? result.items : [];
        const rawSpecs = result?.specs || {};

        const items = rawItems.filter((item: any) => {
            // Post-Processing Filter: Remove obvious appliances/garbage if AI failed
            const desc = (item.description || "").toUpperCase();
            const code = (item.code || "").toUpperCase();

            if (desc.includes("FRIDGE") && !desc.includes("PANEL") && !desc.includes("CABINET")) return false;
            if (desc.includes("DISHWASHER") && !desc.includes("PANEL") && !desc.includes("RETURN")) return false;
            if (desc.includes("RANGE") && !desc.includes("HOOD") && !desc.includes("CABINET")) return false;
            if (desc.includes("SINK") && !desc.includes("BASE") && !desc.includes("FRONT") && !desc.includes("CABINET")) return false;
            if (code === "PAGE" || code.startsWith("PAGE ")) return false;

            return true;
        }).map((item: any, index: number) => {
            let type: CabinetType = 'Base';

            // Map AI type string to valid CabinetType
            const rawType = (item.type || '').toString().toLowerCase();
            const code = (item.code || "").toUpperCase();

            if (rawType.includes('wall')) type = 'Wall';
            else if (rawType.includes('tall') || rawType.includes('pantry') || code.startsWith('U') || code.startsWith('T')) type = 'Tall';
            else if (rawType.includes('filler')) type = 'Filler';
            else if (rawType.includes('panel') || rawType.includes('skin')) type = 'Panel';
            else if (rawType.includes('accessory') || rawType.includes('molding') || rawType.includes('kit') || rawType.includes('toe')) type = 'Accessory';
            else type = 'Base'; // Default

            const originalCode = item.code || "UNKNOWN";
            let normalizedCode = item.normalizedCode || originalCode;

            // Cleanup Code
            normalizedCode = normalizedCode.toUpperCase().replace(/\s+/g, '');

            // Fallback Logic for dimensions if AI missed them
            let width = typeof item.width === 'number' ? item.width : 0;
            let height = typeof item.height === 'number' ? item.height : 0;
            let depth = typeof item.depth === 'number' ? item.depth : 0;

            // Extract from NKBA code if 0 (e.g. W3030 -> 30W 30H)
            if (width === 0 && normalizedCode.match(/[A-Z]+(\d{2,})/)) {
                const nums = normalizedCode.match(/(\d+)/)?.[0];
                if (nums) {
                    if (nums.length >= 2) width = parseInt(nums.substring(0, 2));
                    if (nums.length >= 4 && type === 'Wall') height = parseInt(nums.substring(2, 4));
                }
            }

            // Defaults
            if (height === 0) {
                if (type === 'Base') height = 34.5;
                if (type === 'Wall') height = 30;
                if (type === 'Tall') height = 84;
            }

            return {
                id: `extracted-${index}-${Date.now()}`,
                originalCode: originalCode,
                normalizedCode: normalizedCode,
                type: type,
                description: item.description || `Item ${index + 1}`,
                width: width,
                height: height,
                depth: depth,
                quantity: typeof item.qty === 'number' ? item.qty : 1,
                notes: item.notes || "",
                extractedPrice: item.extractedPrice || undefined,
                modifications: Array.isArray(item.modifications) ? item.modifications : []
            };
        });

        const constructionNote = rawSpecs.construction ? ` [Construction: ${rawSpecs.construction}]` : "";

        return {
            specs: {
                manufacturer: rawSpecs.manufacturer || "",
                wallDoorStyle: rawSpecs.doorStyle || "",
                baseDoorStyle: rawSpecs.doorStyle || "",
                finishColor: rawSpecs.finish || "",
                notes: (rawSpecs.notes || "") + constructionNote,
                selectedOptions: {}
            },
            items
        };
    } catch (error: any) {
        console.error("AI Generation Error Full:", JSON.stringify(error, null, 2));
        throw new Error(`AI Analysis Failed: ${error.message}`);
    }
}

// NEW: AI-Powered Excel Structure Analysis
export async function determineExcelStructure(sheetName: string, sampleRows: any[][]): Promise<{
    skuColumn: number | null,
    priceColumns: { index: number, name: string }[],
    optionTableType?: 'Stain' | 'Paint' | null,
    doorStyleName?: string | null // NEW: Detect Door Style name from sheet
}> {
    const ai = getAI();
    const dataStr = sampleRows.map((row, i) => `Row ${i}: ${row.slice(0, 15).map(c => String(c).substring(0, 20)).join(' | ')}`).join('\n');

    const prompt = `
    Analyze this spreadsheet sample (Sheet: "${sheetName}").
    
    TASK 1: CATALOGUE
    Identify the Column Index (0-based) for "SKU" (Product Code) and Column Indices for "Price".
    NOTE: Unstructured data handling:
    - SKUs look like "W3030", "B15", "LS36", "TK8", "VDB27AH-3". They contain letters and numbers.
    - Prices are numeric (e.g., 450, 1200.50).
    - If there are multiple price columns (e.g. "Oak", "Maple", "Paint Grade"), list ALL of them with their names.
    - If headers are messy, deduce columns by the CONTENT pattern in the rows.
    
    TASK 2: PRINTED END OPTIONS (Specific)
    Does this sheet contain a table listing "Stain" or "Paint" options with a "Yes"/"No" column?
    Look for headers like "STAIN", "PAINT", "PAINT GRADE".
    If found, set optionTableType.

    TASK 3: DOOR STYLE DEFINITION
    Does this sheet define a specific Door Style? 
    Look for a header cell containing text like "ASHLAND DOOR STYLE" or "HIGHLAND DOOR STYLE" or "LIBERTY DOOR STYLE".
    If found, extract the pure style name (e.g. "Ashland", "Highland", "Nova", "Liberty").
    Ignore generic headers like "DOOR STYLES".
    **CRITICAL FALLBACK**: If the sheet name itself is NOT a generic section (like "Base", "Wall", "Summary") and headers are missing, assume the Sheet Name IS the Door Style Name (e.g. Sheet "Ashland" -> Style "Ashland").
    
    Return JSON:
    {
       "skuColumn": number | null,
       "priceColumns": [ { "index": number, "name": "string" } ],
       "optionTableType": "Stain" | "Paint" | null,
       "doorStyleName": string | null
    }
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: { parts: [{ text: prompt }, { text: dataStr }] },
            config: {
                responseMimeType: "application/json",
                temperature: 0.0 // Deterministic
            }
        });

        const text = response.text || "{}";
        const clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(clean);
    } catch (e) {
        console.warn("AI Structure Analysis failed", e);
        return { skuColumn: null, priceColumns: [], optionTableType: null };
    }
}
