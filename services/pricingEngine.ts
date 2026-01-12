import { CabinetItem, Manufacturer, PricingLineItem, ProjectSpecs } from '../types';

// --- NEW HELPER: Standardize Code for Lookup ---
export const normalizeNKBACode = (rawCode: string): string => {
    if (!rawCode) return "";
    let code = rawCode.toUpperCase().trim();

    // 1. Fix Common OCR Symbol Errors
    code = code.replace(/\$/g, 'B'); // 3D$ -> 3DB
    code = code.replace(/€/g, 'E');
    code = code.replace(/@/g, '0');

    // Aggressive Space Removal
    code = code.replace(/\s+/g, '');

    // 2. Fix "BD1 015" -> "BD15" pattern (The '1' is often a pipe '|' or noise before a zero-padded number)
    // Target specific pattern: [Letters] + 10 + [2 Digits]
    if (/^[A-Z]+10\d{2}/.test(code)) {
         code = code.replace(/([A-Z]+)10(\d{2})/, '$1$2'); 
    }
    // Target B015 -> B15
    if (/^[A-Z]+0\d{2}/.test(code)) {
         code = code.replace(/([A-Z]+)0(\d{2})/, '$1$2');
    }

    // 3. Handle specific Manufacturer Suffixes that are directional/cosmetic only
    code = code.replace(/-?2B$/, ''); 
    code = code.replace(/-?BUTT$/, '');

    // Remove "-L", "-R", "-LH", "-RH" ONLY if it's the very end
    // BE CAREFUL: VDB27AH-3 needs the -3. We only strip single letter directionals usually.
    if (/[0-9][LR]$/.test(code) || /[0-9]-[LR]$/.test(code)) {
        code = code.replace(/-?[LR]$/, '');
    }
    code = code.replace(/-?LH$/, '').replace(/-?RH$/, '');

    // Remove Finished End suffixes
    code = code.replace(/-?FE[LR]?$/, '');
    code = code.replace(/-?FE$/, '');

    return code;
};

// Helper to determine if an item is purely metadata/garbage
const isGarbageItem = (item: CabinetItem): boolean => {
    const text = (item.originalCode + " " + item.description).toUpperCase();
    const badWords = [
        'PAGE ', 'OF PAGE', 'SUB TOTAL', 'SUBTOTAL', 'GRAND TOTAL', 'ORDER TOTAL', 
        'TAX', 'SHIPPING', 'JOB NAME', 'PROJECT:', 'QUOTE:', 'DATE:', 'SIGNATURE',
        'CABINET SPECIFICATIONS', 'CONSTRUCTION:', 'DOOR STYLE:', 'LAYOUT'
    ];
    
    // Check for "Page X of Y" pattern
    if (/PAGE\s+\d+\s+OF\s+\d+/.test(text)) return true;

    // Check key phrases
    if (badWords.some(w => text.includes(w))) return true;

    // Check if Code is ridiculously long textual sentence
    if (item.originalCode.length > 20 && item.originalCode.includes(' ')) return true;
    
    // Check if description is "Kitchen" or similar generic header
    if (item.originalCode === 'KITCHEN' || item.description === 'KITCHEN') return true;

    // New: Filter out obvious appliance headers if AI missed them
    if (text.includes('REFRIGERATOR') && !text.includes('PANEL') && !text.includes('CABINET')) return true;
    if (text.includes('RANGE') && !text.includes('HOOD') && !text.includes('CABINET')) return true;

    return false;
};

// Helper to generate manufacturer-specific permutation keys based on NKBA standards
const generateSmartKeys = (item: CabinetItem): string[] => {
    const keys: string[] = [];
    const { width, height, depth, type, originalCode, normalizedCode } = item;
    
    const cleanCode = normalizeNKBACode(originalCode);
    const cleanNorm = normalizeNKBACode(normalizedCode || '');

    // Helper: Add key and its variations
    const add = (k: string) => {
        if (!k) return;
        const upper = k.toUpperCase().replace(/\s+/g, ''); // Ensure no spaces
        if (!keys.includes(upper)) keys.push(upper);
        
        // Add hyphenated variations for common break points: [Letters][Numbers] -> [Letters]-[Numbers]
        // e.g. B15 -> B-15 (rare but possible) or VDB24 -> VDB-24
        if (upper.match(/^[A-Z]+\d+$/)) {
            const split = upper.match(/^([A-Z]+)(\d+)$/);
            if (split) {
                const hyphenated = `${split[1]}-${split[2]}`;
                if (!keys.includes(hyphenated)) keys.push(hyphenated);
            }
        }

        // Add variation stripping arbitrary suffixes like -W, -A, -B (often cosmetic or misread)
        // e.g. VDB24-W -> VDB24
        if (upper.includes('-')) {
            const [base, suffix] = upper.split('-');
            if (base.length > 2 && suffix.length === 1) {
                if (!keys.includes(base)) keys.push(base);
            }
        }
    };

    // --- STRATEGY 1: EXPLICIT CLEAN CODES ---
    add(originalCode);
    add(cleanCode);
    if (normalizedCode) add(normalizedCode);
    add(cleanNorm);

    // --- STRATEGY 1.5: COMMON TYPO TRANSPOSITION (The VDB/VBD Fix) ---
    // Excel sheet often has 'VBD' instead of 'VDB' or vice versa
    if (cleanCode.includes('VDB')) add(cleanCode.replace('VDB', 'VBD'));
    if (cleanCode.includes('VBD')) add(cleanCode.replace('VBD', 'VDB'));

    // --- STRATEGY 2: HANDLE COMPLEX COMBINATIONS (e.g. 3DB2136 -> 3DB21) ---
    // Regex: Start with non-digits, then digits, then 2 digits at end (height)
    const complexMatch = cleanCode.match(/^([0-9A-Z]+)(\d{2})$/);
    if (complexMatch) {
        const [_, prefix, suffix] = complexMatch;
        const sVal = parseInt(suffix);
        // If the suffix looks like a height (30-42) and likely redundant for base/vanity pricing
        if (sVal >= 30 && sVal <= 42) {
             add(prefix); 
        }
    }

    // --- STRATEGY 3: HANDLE VANITY/WALL CONFUSION (WDH -> VDB/VSB) ---
    // OCR often mistakes 'V' for 'W'. If it's WDH (Wall Diagonal), it might be VDB (Vanity Drawer Base)
    // Also user reported: WDH24-W -> Sink.
    if (cleanCode.startsWith('W') || cleanCode.startsWith('WD')) {
        // Specific fixes for common misreads or non-standard "WDH" usage for vanity
        if (cleanCode.startsWith('WDH')) {
            const remainder = cleanCode.replace('WDH', ''); // e.g. 24-W or 24
            
            // Try explicit Vanity mappings
            add(`VDB${remainder}`); // Vanity Drawer Base
            add(`VBD${remainder}`); // Typo check
            add(`VSB${remainder}`); // Vanity Sink Base
            add(`SB${remainder}`);  // Sink Base
            
            // Also try just 'B' or 'DB' if it was a misread Base
            add(`DB${remainder}`);
            add(`B${remainder}`);
        }
    }
    
    // --- STRATEGY 4: SIMILAR CABINET FALLBACK (Reduction) ---
    // User Request: "if not match to try with similar cabinet code pricing"
    // e.g. VDB27AH-3 -> VDB27-3 (Remove middle letters) -> VDB27 (Base)
    
    // 4a. Strip middle letters between digits? (e.g. VDB27AH-3 -> VDB27-3)
    const middleLetterMatch = cleanCode.match(/^([A-Z0-9]+)(\d{2})([A-Z]+)(-\d+)$/); 
    if (middleLetterMatch) {
        // [VDB][27][AH][-3] -> VDB27-3
        add(`${middleLetterMatch[1]}${middleLetterMatch[2]}${middleLetterMatch[4]}`);
    }

    // 4b. Base Fallback (Strip Suffixes entirely)
    // VDB27AH-3 -> VDB27
    const baseMatch = cleanCode.match(/^([A-Z]+)(\d+)/);
    if (baseMatch) {
        add(`${baseMatch[1]}${baseMatch[2]}`); // VDB27
        if (baseMatch[1] === 'VDB') add(`VBD${baseMatch[2]}`); // Typo check
    }

    // --- STRATEGY 5: REMOVE INTERNAL DASHES ---
    // VDB-27-AH-3 -> VDB27AH-3
    if (cleanCode.split('-').length > 2) {
         add(cleanCode.replace(/-/g, ''));
    }

    // --- STRATEGY 6: CONSTRUCTED KEYS FROM DIMENSIONS ---
    if (width > 0) {
        const w = width;
        const h = height;
        const d = depth;

        if (type === 'Wall') {
             const hVal = h || 30;
             add(`W${w}${hVal}`);
             if (d > 12) add(`W${w}${hVal}-24`);
        } else if (type === 'Base') {
             add(`B${w}`);
             add(`DB${w}`); 
             add(`SB${w}`); 
             add(`3DB${w}`);
             add(`B${w}D`);
        } else if (type === 'Tall') {
             const hVal = h || 84;
             add(`U${w}${hVal}`);
             add(`T${w}${hVal}`);
        } else if (type === 'Filler') {
             add(`F${w}`);
        } else if (type === 'Panel') {
             add(`PNL${w}`);
             add(`BP${w}`);
        }
    }

    return Array.from(new Set(keys));
};

// Helper to normalize lookups consistently with Admin ingestion
const normalizeLookup = (sku: string): string => {
    return sku.trim()
        .toUpperCase()
        .replace(/\u2013|\u2014/g, '-') // Normalize dashes
        .replace(/\s+/g, ''); // Remove spaces
}

const findCatalogPrice = (
  rawSku: string, 
  catalog: Record<string, Record<string, number>>, 
  tierId: string
): { price: number; source: string; matchedSku: string } | null => {
  const cleanSku = normalizeLookup(rawSku);
  if (!cleanSku || cleanSku === "UNKNOWN") return null;

  // 1. Exact Match
  if (catalog[cleanSku]) {
     return getPriceFromItem(catalog[cleanSku], tierId, cleanSku, 'Exact');
  }
  
  // 2. Hyphen Insensitivity (Remove all dashes)
  // If cleanSku is VDB27AH-3, catalog might have VDB27AH3
  const skuNoDash = cleanSku.replace(/-/g, '');
  if (catalog[skuNoDash]) return getPriceFromItem(catalog[skuNoDash], tierId, cleanSku, 'Hyphen-Insensitive');

  // 3. Hyphen Insertion for [Letters][Numbers][Letters][Numbers] pattern
  // Target: VDB27AH3 -> VDB27AH-3
  // Regex: Ends with [Digit], preceded by [Letter]
  if (/[A-Z]\d+$/.test(cleanSku)) { 
      // check if it ends with digit group
      const suffixMatch = cleanSku.match(/(\d+)$/);
      if (suffixMatch) {
          const suffix = suffixMatch[1];
          const prefix = cleanSku.substring(0, cleanSku.length - suffix.length);
          // Only insert dash if prefix ends with letter
          if (/[A-Z]$/.test(prefix)) {
               const withDash = `${prefix}-${suffix}`;
               if (catalog[withDash]) return getPriceFromItem(catalog[withDash], tierId, cleanSku, 'Inserted-Hyphen (VDB27AH-3)');
          }
      }
  }

  // 4. Neighbor Search (Height +/- 2 inches)
  const wallMatch = cleanSku.match(/^(W\d{2})(\d{2})([A-Z]*)$/);
  if (wallMatch) {
      const [_, prefix, hStr, suffix] = wallMatch;
      const h = parseInt(hStr);
      const neighbors = [h+1, h-1, h+2, h-2];
      for (const nh of neighbors) {
          const candidate = `${prefix}${nh}${suffix}`;
          if (catalog[candidate]) return getPriceFromItem(catalog[candidate], tierId, candidate, `Neighbor (Matched ${candidate})`);
          if (suffix) {
              const simpleCandidate = `${prefix}${nh}`;
              if (catalog[simpleCandidate]) return getPriceFromItem(catalog[simpleCandidate], tierId, simpleCandidate, `Neighbor (Matched ${simpleCandidate})`);
          }
      }
  }

  // 5. Fuzzy Suffix Stripping (Iterative)
  // Limit to reasonable length to avoid matching "B" from "B15"
  for (let i = cleanSku.length - 1; i > 2; i--) {
      const sub = cleanSku.substring(0, i);
      if (catalog[sub]) {
          const strippedPart = cleanSku.substring(i);
          return getPriceFromItem(catalog[sub], tierId, sub, `Similar (Stripped ${strippedPart})`);
      }
  }

  // 6. Regex Core Extraction (Letters+Numbers)
  const heuristic = cleanSku.match(/^([A-Z]{1,4}\d{2,5})/);
  if (heuristic) {
      const core = heuristic[0];
      if (catalog[core]) return getPriceFromItem(catalog[core], tierId, core, 'Core Extraction');
  }

  return null;
};

// Helper to extract specific tier price from item object
const getPriceFromItem = (item: Record<string, number>, tierId: string, sku: string, method: string) => {
      if (item[tierId] !== undefined) return { price: item[tierId], source: `Catalog (${method} Tier)`, matchedSku: sku };
      
      const fuzzyTier = Object.keys(item).find(k => k.toLowerCase().includes(tierId.toLowerCase()) || tierId.toLowerCase().includes(k.toLowerCase()));
      if (fuzzyTier) return { price: item[fuzzyTier], source: `Catalog (${method} Fuzzy '${fuzzyTier}')`, matchedSku: sku };
      
      const firstKey = Object.keys(item)[0];
      if (firstKey) return { price: item[firstKey], source: `Catalog (${method} Fallback '${firstKey}')`, matchedSku: sku };
      
      return null;
}

export const calculateProjectPricing = (
  items: CabinetItem[],
  manufacturer: Manufacturer,
  tierId: string, 
  specs?: ProjectSpecs
): PricingLineItem[] => {
  const tier = manufacturer.tiers.find(t => t.id === tierId) || manufacturer.tiers[0];
  const tierNameForLookup = tier ? tier.name : (specs?.priceGroup || 'Standard');
  const activeOptions = manufacturer.options?.filter(opt => !!specs?.selectedOptions?.[opt.id]) || [];

  const results: PricingLineItem[] = [];

  items.forEach(item => {
    // 0. Garbage Check
    if (isGarbageItem(item)) return; // Skip this item entirely

    let basePrice = 0;
    let source = 'Unknown';
    let optionsPrice = 0;
    let matchedSku = item.originalCode;
    const appliedOptionsLog: { name: string; price: number; sourceSection?: string }[] = [];

    // 1. MODIFICATIONS
    if (item.modifications && item.modifications.length > 0) {
        item.modifications.forEach(mod => {
            optionsPrice += (mod.price || 0);
            appliedOptionsLog.push({ name: mod.description, price: mod.price || 0, sourceSection: 'PDF Extraction' });
        });
    }

    // 2. MANUFACTURER OPTIONS
    activeOptions.forEach(opt => {
        let applies = true;
        if (opt.section === 'E-Drawer' && item.type !== 'Base') applies = false;
        if (opt.section === 'F-Hinge' && item.type === 'Filler') applies = false;
        if (opt.section === 'F-Hinge' && item.type === 'Panel') applies = false;
        if (opt.name.toLowerCase().includes('wall') && item.type !== 'Wall') applies = false;
        if (opt.name.toLowerCase().includes('base') && item.type !== 'Base') applies = false;

        if (applies) {
            let addPrice = 0;
            if (opt.pricingType === 'fixed') addPrice = opt.price;
            if (addPrice > 0) {
                optionsPrice += addPrice;
                appliedOptionsLog.push({ name: opt.name, price: addPrice, sourceSection: opt.section });
            }
        }
    });

    // 3. BASE PRICE
    let match: any = null;
    const smartKeys = generateSmartKeys(item);
    
    // Try original code first with robust lookup
    match = findCatalogPrice(item.originalCode, manufacturer.catalog || {}, tierNameForLookup);

    // If not found, try smart keys
    if (!match) {
        for (const key of smartKeys) {
            match = findCatalogPrice(key, manufacturer.catalog || {}, tierNameForLookup);
            if (match) {
                match.source = `Catalog (Similar '${key}')`;
                break;
            }
        }
    }
    
    if (match) {
        basePrice = match.price;
        source = match.source;
        matchedSku = match.matchedSku;
    } else if (item.extractedPrice && item.extractedPrice > 0) {
        basePrice = item.extractedPrice;
        source = 'Extracted from PDF';
    } else {
        basePrice = 0;
        source = 'NOT FOUND';
    }

    // 4. PERCENTAGE OPTIONS
    activeOptions.forEach(opt => {
         if (opt.section === 'D-Finish' || opt.pricingType === 'percentage') {
             const addPrice = basePrice * opt.price; 
             optionsPrice += addPrice;
             appliedOptionsLog.push({ name: `${opt.name} (%)`, price: addPrice, sourceSection: opt.section });
         }
    });

    const adjustedBase = basePrice * manufacturer.basePricingMultiplier;
    const tierMultiplier = tier ? tier.multiplier : 1.0;
    const finalUnitPrice = (adjustedBase + optionsPrice) * tierMultiplier;
    const totalPrice = finalUnitPrice * item.quantity;

    results.push({
      ...item,
      normalizedCode: matchedSku,
      basePrice: Math.round(adjustedBase),
      optionsPrice: Math.round(optionsPrice),
      tierMultiplier,
      finalUnitPrice: Math.round(finalUnitPrice),
      totalPrice: Math.round(totalPrice),
      tierName: tier ? tier.name : 'Standard',
      source,
      appliedOptions: appliedOptionsLog
    });
  });

  return results;
};