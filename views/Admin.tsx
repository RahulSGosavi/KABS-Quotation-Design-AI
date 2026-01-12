import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trash2, Plus, Upload, FileSpreadsheet, FileText, AlertTriangle, CheckCircle, RefreshCw, X, Loader2, Database, Image as ImageIcon, Settings2, Sparkles, ArrowLeft } from 'lucide-react';
import { Button } from '../components/Button';
import { Manufacturer, ManufacturerFile, NKBARules, PricingTier, ManufacturerOption, CabinetSeries, WorkbookSection } from '../types';
import { storage } from '../services/storage';
import { determineExcelStructure } from '../services/ai';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';

// --- HELPERS ---

const guessSection = (sheetName: string): WorkbookSection => {
    const s = sheetName.toLowerCase();
    if (s.includes('series') || s.includes('line')) return 'B-Series';
    if (s.includes('printed') || (s.includes('options') && s.includes('end'))) return 'M-PrintedEnds';
    if (s.includes('door') || s.includes('style')) return 'C-Door';
    if (s.includes('finish') || s.includes('paint') || s.includes('stain') || s.includes('wood') || s.includes('specie')) return 'D-Finish';
    if (s.includes('drawer') || s.includes('box') || s.includes('front')) return 'E-Drawer';
    if (s.includes('hinge') || s.includes('hardware') || s.includes('close')) return 'F-Hinge';
    if (s.includes('construction') || s.includes('panel') || s.includes('end') || s.includes('upgrade')) return 'G-Construction';
    if (s.includes('wall') && s.includes('price')) return 'H-WallPrice';
    if (s.includes('wall')) return 'H-WallPrice';
    if (s.includes('base') && s.includes('price')) return 'I-BasePrice';
    if (s.includes('base')) return 'I-BasePrice';
    if (s.includes('tall') || s.includes('pantry') || s.includes('utility')) return 'J-TallPrice';
    if (s.includes('accessory') || s.includes('filler') || s.includes('toe') || s.includes('molding')) return 'K-Accessory';
    if (s.includes('summary') || s.includes('total') || s.includes('note')) return 'L-Summary';
    if (s.includes('project') || s.includes('area') || s.includes('info')) return 'A-Context';
    return 'Unknown';
};

const mapSectionToCategory = (sec: WorkbookSection): ManufacturerOption['category'] => {
    switch (sec) {
        case 'B-Series': return 'Series';
        case 'C-Door': return 'Door';
        case 'D-Finish': return 'Finish';
        case 'E-Drawer': return 'Drawer';
        case 'F-Hinge': return 'Hinge';
        case 'G-Construction': return 'Construction';
        case 'M-PrintedEnds': return 'PrintedEnd';
        default: return 'Other';
    }
};

const normalizeImportSku = (val: any): string => {
    return String(val)
        .trim()
        .toUpperCase()
        .replace(/\u2013|\u2014/g, '-')
        .replace(/\s+/g, '');
};

const findBestSkuInRow = (row: any[], primaryIndex: number | null): string | null => {
   const skuRegex = /^[A-Z]{1,4}\d{1,4}[A-Z0-9\-\.]*$/;
   
   if (primaryIndex !== null && row[primaryIndex]) {
       const val = normalizeImportSku(row[primaryIndex]);
       if (skuRegex.test(val) && val.length >= 2 && val.length < 15) return val;
   }

   for (let i = 0; i < Math.min(row.length, 12); i++) {
       if (!row[i]) continue;
       const val = normalizeImportSku(row[i]);
       if (val.length < 2 || val.length > 20) continue;
       if (val.match(/^(PAGE|ITEM|QTY|NOTE|DESC|PRICE|WIDTH|HEIGHT|DEPTH|SKU|CODE)/)) continue;
       if (!/[A-Z]/.test(val)) continue;
       if (!/\d/.test(val)) continue;
       if (skuRegex.test(val)) return val;
   }
   return null;
}

// Helper to parse price value and type from a cell
const parseOptionPrice = (cellValue: any, headerValue: string = ''): { price: number, pricingType: 'fixed' | 'percentage' | 'included' } => {
    if (!cellValue) return { price: 0, pricingType: 'included' };
    
    let strVal = String(cellValue).trim();
    if (strVal === '-' || strVal === '' || strVal.toLowerCase().includes('n/c') || strVal.toLowerCase().includes('no charge')) return { price: 0, pricingType: 'included' };
    
    const isPercent = strVal.includes('%') || headerValue.includes('%') || headerValue.includes('PCT');
    // Handle "+$150" or "15%"
    let val = parseFloat(strVal.replace(/[^0-9.-]/g, ''));
    
    if (isNaN(val) || val === 0) return { price: 0, pricingType: 'included' };
    
    if (isPercent) {
        // e.g. "15%" -> 15 -> 0.15
        if (val > 1) val = val / 100; 
        return { price: val, pricingType: 'percentage' };
    }
    
    // Heuristic: If val is small (< 1.0) it's likely a percentage (e.g. 0.15)
    if (val < 1.0 && val > -1.0) {
        return { price: val, pricingType: 'percentage' };
    }
    
    return { price: val, pricingType: 'fixed' };
}

// Helper to detect if a cell value looks like a price
const isPriceCell = (val: any): boolean => {
    const s = String(val).trim();
    if (!s || s === '-') return false;
    if (s.includes('$') || s.includes('%')) return true;
    const n = parseFloat(s);
    return !isNaN(n) && isFinite(n);
};

// --- MAIN COMPONENT ---

export const Admin: React.FC = () => {
  const navigate = useNavigate();
  
  // Data State - Initialize from LocalStorage for IMMEDIATE render
  const [manufacturers, setManufacturers] = useState<Manufacturer[]>(() => {
      try {
          const local = localStorage.getItem('kabs_local_manufacturers');
          return local ? JSON.parse(local) : [];
      } catch (e) { return []; }
  });

  const [nkbaRules, setNkbaRules] = useState<NKBARules | null>(() => {
      try {
          const local = localStorage.getItem('kabs_local_nkba_rules');
          return local ? JSON.parse(local) : null;
      } catch (e) { return null; }
  });
  
  // UI State
  const [showAddModal, setShowAddModal] = useState(false);
  const [newMfgName, setNewMfgName] = useState('');
  const [managingMfg, setManagingMfg] = useState<Manufacturer | null>(null);
  const [activeCatalog, setActiveCatalog] = useState<Record<string, any>>({});
  
  // Loading States
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null); // For Deleting Manufacturer
  const [deletingFileId, setDeletingFileId] = useState<string | null>(null); // For Deleting specific file
  
  // Refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pricingInputRef = useRef<HTMLInputElement>(null);

  // --- INITIAL LOAD & SYNC ---
  useEffect(() => {
    const loadData = async () => {
        const isAdmin = sessionStorage.getItem('kabs_is_admin');
        if (!isAdmin) {
            navigate('/login');
            return;
        }
        // Data is already initially populated from localStorage in useState logic above.
        // We now fetch fresh data to sync.
        try {
            const [mfgList, rules] = await Promise.all([
                storage.getManufacturers(),
                storage.getNKBARules()
            ]);
            // Update state (and re-render) only if we got data
            if (mfgList) setManufacturers(mfgList);
            if (rules) setNkbaRules(rules);
        } catch (e) {
            console.error("Failed to sync admin data", e);
        }
    };
    loadData();
  }, [navigate]);

  // --- CATALOG FETCHING ---
  useEffect(() => {
      const fetchCat = async () => {
          if (managingMfg) {
              const cat = await storage.getManufacturerCatalog(managingMfg.id);
              setActiveCatalog(cat || {});
          } else {
              setActiveCatalog({});
          }
      };
      fetchCat();
  }, [managingMfg]);

  // --- ACTIONS ---

  const handleAddMfg = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMfgName) return;
    const newMfg: Manufacturer = {
      id: crypto.randomUUID(),
      name: newMfgName,
      basePricingMultiplier: 1.0,
      tiers: [{ id: 'default', name: 'Standard', multiplier: 1.0 }],
      series: [],
      options: [],
      files: [],
      catalogImages: [],
      skuCount: 0
    };
    try {
      await storage.saveManufacturer(newMfg, {});
      const updatedList = await storage.getManufacturers();
      setManufacturers(updatedList);
      setShowAddModal(false);
      setNewMfgName('');
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDeleteMfg = async (id: string) => {
    setDeletingId(id);
    try {
      await storage.deleteManufacturer(id);
      setManufacturers(prev => prev.filter(m => m.id !== id));
      if (managingMfg?.id === id) setManagingMfg(null);
    } catch (err: any) {
      alert(`Failed to delete: ${err.message}`);
      // Refresh list if failed
      setManufacturers(await storage.getManufacturers());
    } finally {
      setDeletingId(null);
    }
  };

  const handleDeleteFile = async (fileId: string) => {
    if (!managingMfg) return;
    setDeletingFileId(fileId);

    const updatedFiles = (managingMfg.files || []).filter(f => f.id !== fileId);
    
    // Note: This only removes the file record. Removing merged SKUs is not supported without re-upload.
    const updatedMfg: Manufacturer = {
        ...managingMfg,
        files: updatedFiles
    };

    try {
        await storage.saveManufacturerMetadata(updatedMfg);
        setManagingMfg(updatedMfg);
        setManufacturers(prev => prev.map(m => m.id === updatedMfg.id ? updatedMfg : m));
    } catch (err: any) {
        console.error("Delete failed", err);
        alert("Failed to delete file: " + err.message);
    } finally {
        setDeletingFileId(null);
    }
  };

  const readFileAsBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const readFileAsArrayBuffer = (file: File): Promise<ArrayBuffer> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  };

  const handleNKBAUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setUploading(true);
      setUploadStatus("Uploading NKBA Rules...");
      try {
        const base64Data = await readFileAsBase64(file);
        const newRules: NKBARules = {
          filename: file.name,
          uploadDate: new Date().toISOString(),
          size: file.size,
          isActive: true,
          data: base64Data
        };
        await storage.saveNKBARules(newRules);
        setNkbaRules(newRules);
      } catch (err: any) {
        console.error(err);
        alert(err.message || "Failed to upload file.");
      } finally {
        setUploading(false);
        setUploadStatus("");
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    }
  };

  const handleMfgFileUpload = async (type: 'pricing' | 'spec', e: React.ChangeEvent<HTMLInputElement>) => {
    if (!managingMfg || !e.target.files?.[0]) return;
    const file = e.target.files[0];
    
    setUploading(true);
    setUploadStatus("Loading file...");
    await storage.ensureBucket();

    try {
      const base64Data = await readFileAsBase64(file);
      
      let updatedCatalog = { ...activeCatalog };
      let updatedTiers = [...managingMfg.tiers];
      let updatedSeries = [...(managingMfg.series || [])];
      let updatedOptions = [...(managingMfg.options || [])];
      let allImages: string[] = [...(managingMfg.catalogImages || [])];

      if (type === 'pricing') {
          try {
            const ab = await readFileAsArrayBuffer(file);
            setUploadStatus("AI Scanning Workbook...");
            await new Promise(r => setTimeout(r, 50)); 

            const workbook = XLSX.read(ab);
            let parsedCount = 0;
            const foundPriceHeaders = new Set<string>();

            for (const sheetName of workbook.SheetNames) {
                const sheet = workbook.Sheets[sheetName];
                const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" }) as any[][];
                if (!rows || rows.length < 5) continue; 

                const section = guessSection(sheetName);
                if (section === 'A-Context' || section === 'L-Summary') continue;
                
                setUploadStatus(`Analyzing Structure: ${sheetName}...`);

                const sampleRows = rows.slice(0, 100);
                if (rows.length > 200) {
                    const mid = Math.floor(rows.length / 2);
                    sampleRows.push(...rows.slice(mid, mid + 10));
                }

                const structure = await determineExcelStructure(sheetName, sampleRows);
                const stylePrefix = structure.doorStyleName ? `${structure.doorStyleName} - ` : '';

                if (structure.doorStyleName) {
                    if (!/^\d+$/.test(structure.doorStyleName) && structure.doorStyleName.length > 2) {
                        const exists = updatedOptions.find(o => o.category === 'DoorStyle' && o.name === structure.doorStyleName);
                        if (!exists) {
                            updatedOptions.push({
                                id: `style_${structure.doorStyleName.replace(/\s+/g,'_').toLowerCase()}`,
                                name: structure.doorStyleName,
                                category: 'DoorStyle',
                                section: 'C-Door', 
                                pricingType: 'included',
                                price: 0,
                                sourceSheet: sheetName
                            });
                        }
                    }
                }
                
                // Option Table Scanning (Stain/Paint/Generic)
                if (section === 'M-PrintedEnds' || section === 'Unknown' || section === 'D-Finish' || sheetName.toUpperCase().includes('FINISH')) {
                     // DYNAMIC HEADER DETECTION
                     let stainCols: { nameIdx: number, availIdx?: number, priceIdx?: number } | null = null;
                     let paintCols: { nameIdx: number, availIdx?: number, priceIdx?: number } | null = null;
                     
                     // 1. SCAN FOR HEADERS
                     for(let r=0; r<Math.min(rows.length, 40); r++) {
                         const row = rows[r];
                         for(let c=0; c<row.length; c++) {
                             const cell = String(row[c]).trim().toUpperCase();
                             
                             const checkAdjacent = (startCol: number) => {
                                 let pIdx = -1;
                                 let aIdx = -1;
                                 
                                 // Look at next 2 cols for explicit headers
                                 for(let i=1; i<=2; i++) {
                                     const nextVal = String(row[startCol + i] || '').toUpperCase();
                                     if(nextVal.match(/PRICE|COST|UPGRADE|ADD|CHARGE|%|\$/)) pIdx = startCol + i;
                                     else if(nextVal.match(/AVAIL|STOCK/)) aIdx = startCol + i;
                                 }
                                 return { pIdx, aIdx };
                             };

                             // STAIN
                             if ((cell.includes('STAIN') || cell.includes('FINISH')) && !stainCols) {
                                 const { pIdx, aIdx } = checkAdjacent(c);
                                 stainCols = { nameIdx: c, priceIdx: pIdx !== -1 ? pIdx : undefined, availIdx: aIdx !== -1 ? aIdx : undefined };
                             }
                             // PAINT
                             if ((cell.includes('PAINT') || cell.includes('COLOR')) && !paintCols) {
                                 const { pIdx, aIdx } = checkAdjacent(c);
                                 paintCols = { nameIdx: c, priceIdx: pIdx !== -1 ? pIdx : undefined, availIdx: aIdx !== -1 ? aIdx : undefined };
                             }
                         }
                     }

                     const processOptionRow = (cols: { nameIdx: number, availIdx?: number, priceIdx?: number }, row: any[], typeName: string) => {
                         const name = String(row[cols.nameIdx]).trim();
                         if (!name || name.length < 2 || name.toUpperCase().includes(typeName.toUpperCase()) || name.toUpperCase() === 'FINISH') return null;

                         // LAZY COLUMN DETECTION: If price column wasn't explicitly found in header
                         let finalPriceIdx = cols.priceIdx;
                         let finalAvailIdx = cols.availIdx;
                         
                         // Peek at neighbors if undefined
                         if (finalPriceIdx === undefined) {
                             if (isPriceCell(row[cols.nameIdx + 1])) finalPriceIdx = cols.nameIdx + 1;
                             else if (isPriceCell(row[cols.nameIdx + 2])) finalPriceIdx = cols.nameIdx + 2;
                         }
                         
                         // Determine Availability vs Price collision
                         // Often "Price" is in column +1, but logic assumed +1 is Avail.
                         let avail = "Yes";
                         if (finalAvailIdx !== undefined) {
                             avail = String(row[finalAvailIdx]).trim();
                         } else if (finalPriceIdx !== cols.nameIdx + 1) {
                             // If price is NOT next door, maybe avail IS next door
                             const possibleAvail = String(row[cols.nameIdx + 1]).trim();
                             if(possibleAvail.length > 0 && !isPriceCell(possibleAvail)) avail = possibleAvail;
                         }

                         // If 'Availability' looks like a price, it's probably the price column
                         if (isPriceCell(avail)) {
                             finalPriceIdx = (finalAvailIdx !== undefined) ? finalAvailIdx : cols.nameIdx + 1;
                             avail = "Yes"; 
                         }

                         let extracted: { price: number, pricingType: 'fixed' | 'percentage' | 'included' } = { price: 0, pricingType: 'included' };
                         if (finalPriceIdx !== undefined) {
                             extracted = parseOptionPrice(row[finalPriceIdx]);
                         }

                         return {
                             name: `${typeName}: ${name}`,
                             category: 'Finish' as const,
                             section: 'D-Finish' as const,
                             pricingType: extracted.pricingType,
                             price: extracted.price,
                             sourceSheet: sheetName,
                             availability: avail
                         };
                     };

                     if (stainCols || paintCols) {
                         rows.forEach((dataRow, idx) => {
                             if (stainCols) {
                                 const opt = processOptionRow(stainCols, dataRow, 'Stain');
                                 if (opt) updatedOptions.push({ id: `opt_stain_${idx}`, ...opt });
                             }
                             if (paintCols) {
                                 const opt = processOptionRow(paintCols, dataRow, 'Paint');
                                 if (opt) updatedOptions.push({ id: `opt_paint_${idx}`, ...opt });
                             }
                         });
                         continue;
                     }
                }

                if (structure.skuColumn !== null || structure.priceColumns.length > 0) {
                    rows.forEach((dataRow, idx) => {
                        const skuVal = findBestSkuInRow(dataRow, structure.skuColumn);
                        if (!skuVal) return;

                        const rawSku = skuVal;
                        const isOptionSheet = ['C-Door', 'D-Finish', 'E-Drawer', 'F-Hinge', 'G-Construction', 'M-PrintedEnds'].includes(section);
                        
                        if (isOptionSheet) {
                            const priceCol = structure.priceColumns[0];
                            const desc = String(dataRow[structure.skuColumn! + 1] || rawSku);
                            
                            if (desc && desc.length > 2) {
                                let extracted: { price: number, pricingType: 'fixed' | 'percentage' | 'included' } = { price: 0, pricingType: 'fixed' };
                                if (priceCol) {
                                    extracted = parseOptionPrice(dataRow[priceCol.index], priceCol.name);
                                }
                                
                                updatedOptions.push({
                                    id: `opt_${section}_${idx}_${Math.random().toString(36).substr(2,5)}`,
                                    name: desc,
                                    category: mapSectionToCategory(section),
                                    section: section,
                                    pricingType: extracted.pricingType,
                                    price: extracted.price,
                                    sourceSheet: sheetName
                                });
                            }
                        } else {
                            if (!updatedCatalog[rawSku]) updatedCatalog[rawSku] = {};
                            structure.priceColumns.forEach(pc => {
                                const priceVal = parseFloat(String(dataRow[pc.index]).replace(/[^0-9.]/g, ''));
                                if (!isNaN(priceVal) && priceVal > 0) {
                                    const fullTierName = stylePrefix + pc.name;
                                    updatedCatalog[rawSku][fullTierName] = priceVal;
                                    foundPriceHeaders.add(fullTierName);
                                }
                            });
                            parsedCount++;
                        }
                    });
                }
            }

            if (parsedCount > 0) {
                const newTiers: PricingTier[] = Array.from(foundPriceHeaders).map(header => ({
                    id: header, name: header, multiplier: 1.0
                }));
                const mergedTiers = [...updatedTiers];
                newTiers.forEach(nt => {
                    if (!mergedTiers.find(t => t.name === nt.name)) mergedTiers.push(nt);
                });
                updatedTiers = mergedTiers.length > 1 && mergedTiers.find(t => t.id === 'default') 
                    ? mergedTiers.filter(t => t.id !== 'default') 
                    : mergedTiers;
            }

            setUploadStatus("Extracting Images...");
            const zip = await JSZip.loadAsync(ab);
            const mediaFolder = zip.folder("xl/media");
            if (mediaFolder) {
                const imageEntries: { path: string, entry: JSZip.JSZipObject }[] = [];
                mediaFolder.forEach((relativePath, zipEntry) => {
                    if (relativePath.match(/\.(png|jpg|jpeg|gif)$/i)) imageEntries.push({ path: relativePath, entry: zipEntry });
                });
                if (imageEntries.length > 0) {
                     const BATCH_SIZE = 5;
                     for (let i = 0; i < imageEntries.length; i += BATCH_SIZE) {
                         const batch = imageEntries.slice(i, i + BATCH_SIZE);
                         const batchPromises = batch.map(async (item) => {
                             try {
                                 const blob = await item.entry.async("blob");
                                 return await storage.uploadCatalogImage(managingMfg.id, item.path, blob);
                             } catch (e) { return null; }
                         });
                         const results = await Promise.all(batchPromises);
                         const validUrls = results.filter((url): url is string => !!url);
                         const uniqueNewUrls = validUrls.filter(url => !allImages.includes(url));
                         allImages = [...allImages, ...uniqueNewUrls];
                         setManagingMfg(prev => prev ? ({ ...prev, catalogImages: allImages }) : null);
                     }
                }
            }
            alert(`Analysis Complete: ${parsedCount} SKUs, ${updatedOptions.length} Options extracted.`);
          } catch (parseErr: any) {
              console.error("Parsing failed", parseErr);
              alert(`File analysis failed: ${parseErr.message}`);
          }
      }
      
      const newFile: ManufacturerFile = {
        id: `file_${Date.now()}`,
        name: file.name,
        type,
        uploadDate: new Date().toISOString(),
        size: file.size,
        data: base64Data
      };

      const updatedMfg: Manufacturer = {
        ...managingMfg,
        tiers: updatedTiers,
        series: updatedSeries,
        options: updatedOptions,
        catalogImages: allImages, 
        files: [...(managingMfg.files || []), newFile],
        skuCount: Object.keys(updatedCatalog).length
      };

      setUploadStatus("Saving...");
      await new Promise(r => setTimeout(r, 50));
      await storage.saveManufacturer(updatedMfg, updatedCatalog);
      
      setManagingMfg(updatedMfg);
      setActiveCatalog(updatedCatalog);
      setManufacturers(await storage.getManufacturers());
      
    } catch (err: any) {
      console.error(err);
      alert(err.message || "Failed to upload file.");
    } finally {
      setUploading(false);
      setUploadStatus("");
      e.target.value = '';
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate('/')} className="shrink-0">
             <ArrowLeft className="w-5 h-5 text-slate-500" />
          </Button>
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Admin Dashboard</h1>
            <p className="text-slate-500 mt-1">Manage manufacturer pricing & specs.</p>
          </div>
        </div>
        <Button onClick={() => setShowAddModal(true)} className="gap-2 w-full sm:w-auto">
          <Plus className="w-4 h-4" /> Add Manufacturer
        </Button>
      </div>

      <div className="grid gap-6">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden min-h-[200px]">
          <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
            <h2 className="font-semibold text-slate-800">Active Manufacturers</h2>
            <span className="text-xs font-medium text-slate-500 bg-slate-200 px-2 py-1 rounded-full">{manufacturers.length} Total</span>
          </div>
          
          {manufacturers.length === 0 ? (
            <div className="p-12 text-center flex flex-col items-center text-slate-400">
               <AlertTriangle className="w-12 h-12 mb-4 text-slate-300" />
               <p className="font-medium text-slate-600">No Manufacturers Configured</p>
               <Button variant="outline" className="mt-6" onClick={() => setShowAddModal(true)}>Add First</Button>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {manufacturers.map((mfg) => (
                  <div key={mfg.id} className="p-6 flex items-start justify-between hover:bg-slate-50 transition-colors">
                    <div className="space-y-3">
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 bg-slate-100 rounded-lg flex items-center justify-center font-bold text-slate-400">
                          {mfg.name.substring(0,2).toUpperCase()}
                        </div>
                        <div>
                          <h3 className="font-bold text-slate-900">{mfg.name}</h3>
                          <div className="flex gap-2 text-xs text-slate-500 mt-1">
                             {(mfg.skuCount || 0) > 0 && (
                               <span className="bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded border border-indigo-100 flex items-center gap-1">
                                  <Database className="w-3 h-3"/> {mfg.skuCount?.toLocaleString()} SKUs
                               </span>
                             )}
                             {(mfg.options?.length || 0) > 0 && (
                               <span className="bg-amber-50 text-amber-700 px-2 py-0.5 rounded border border-amber-100 flex items-center gap-1">
                                  <Settings2 className="w-3 h-3"/> {mfg.options.length} Options
                               </span>
                             )}
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Button variant="outline" size="sm" onClick={() => setManagingMfg(mfg)}>Manage Files</Button>
                      <button 
                         type="button"
                         onClick={(e) => {
                             e.stopPropagation();
                             handleDeleteMfg(mfg.id);
                         }} 
                         className="p-2 text-red-500 hover:bg-red-50 rounded-lg"
                         title="Delete Manufacturer & All Data"
                      >
                        {deletingId === mfg.id ? <Loader2 className="w-4 h-4 animate-spin"/> : <Trash2 className="w-4 h-4"/>}
                      </button>
                    </div>
                  </div>
              ))}
            </div>
          )}
        </div>

        {/* NKBA Rules Section */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
           <h2 className="font-semibold text-slate-800 mb-4">NKBA Rules Management</h2>
           <input type="file" ref={fileInputRef} className="hidden" accept=".pdf" onChange={handleNKBAUpload} />
           
           {!nkbaRules ? (
             <div onClick={() => fileInputRef.current?.click()} className="border-2 border-dashed border-slate-200 rounded-xl p-8 text-center hover:bg-brand-50 cursor-pointer">
                <Upload className="w-6 h-6 mx-auto mb-2 text-slate-400" />
                <p className="text-sm font-medium">{uploading && !uploadStatus ? 'Uploading...' : uploadStatus || 'Upload NKBA Standards PDF'}</p>
             </div>
           ) : (
             <div className="border border-green-200 bg-green-50 rounded-xl p-6 flex justify-between items-center">
                <div>
                    <h3 className="font-bold text-slate-900">{nkbaRules.filename}</h3>
                    <p className="text-xs text-green-600 flex items-center gap-1"><CheckCircle className="w-3 h-3"/> Active</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>Replace</Button>
             </div>
           )}
        </div>
      </div>

      {/* Add Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-2xl">
            <h3 className="text-lg font-bold mb-4">Add New Manufacturer</h3>
            <form onSubmit={handleAddMfg}>
              <input 
                autoFocus className="w-full border border-slate-300 rounded-lg px-4 py-2 mb-4"
                placeholder="Manufacturer Name" value={newMfgName} onChange={e => setNewMfgName(e.target.value)}
              />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setShowAddModal(false)}>Cancel</Button>
                <Button type="submit">Create</Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Manage Files Modal */}
      {managingMfg && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
          <div className="bg-white rounded-xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between p-6 border-b border-slate-100">
              <h3 className="text-xl font-bold">Manage {managingMfg.name}</h3>
              <button onClick={() => setManagingMfg(null)}><X className="w-6 h-6 text-slate-400"/></button>
            </div>
            <div className="p-6 overflow-y-auto space-y-8 flex-1">
              <section>
                 <div className="flex justify-between mb-4">
                    <div>
                        <h4 className="font-semibold text-slate-800 flex items-center gap-2"><FileSpreadsheet className="w-5 h-5 text-green-600"/> Pricing Sheets</h4>
                        <p className="text-xs text-slate-500">Supports .xlsx and .xlsm (Macro Enabled). Images will be extracted.</p>
                    </div>
                    <input type="file" ref={pricingInputRef} className="hidden" accept=".xlsx,.xlsm,.xls" onChange={(e) => handleMfgFileUpload('pricing', e)} />
                    <Button size="sm" variant="outline" onClick={() => pricingInputRef.current?.click()} isLoading={uploading}>
                         {uploading ? (
                             <>
                                <Sparkles className="w-4 h-4 mr-2 animate-pulse text-brand-500"/>
                                {uploadStatus || "Processing..."}
                             </>
                         ) : (
                             "Upload .xlsm / .xlsx"
                         )}
                    </Button>
                 </div>
                 
                 {/* Image Gallery Preview */}
                 {managingMfg.catalogImages && managingMfg.catalogImages.length > 0 && (
                     <div className="mb-4">
                         <h5 className="text-sm font-semibold text-slate-700 mb-2">Extracted Asset Gallery ({managingMfg.catalogImages.length})</h5>
                         <div className="grid grid-cols-6 gap-2 h-24 overflow-hidden relative">
                             {managingMfg.catalogImages.slice(0, 12).map((url, i) => (
                                 <div key={i} className="aspect-square bg-slate-100 rounded border border-slate-200 overflow-hidden">
                                     <img src={url} alt="asset" className="w-full h-full object-cover" />
                                 </div>
                             ))}
                             {managingMfg.catalogImages.length > 12 && (
                                 <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-white to-transparent flex items-end justify-center">
                                     <span className="text-xs font-bold text-slate-500 bg-white/80 px-2 rounded">+ {managingMfg.catalogImages.length - 12} more</span>
                                 </div>
                             )}
                         </div>
                     </div>
                 )}

                 <div className="bg-slate-50 rounded-lg border border-slate-200 p-4">
                    {(managingMfg.files || []).filter(f => f.type === 'pricing').map(f => (
                        <div key={f.id} className="text-sm py-2 flex items-center justify-between group border-b border-slate-100 last:border-0 hover:bg-slate-50 px-2 rounded">
                            <div className="flex items-center gap-2">
                                <CheckCircle className="w-3 h-3 text-green-500"/> 
                                <span className="font-medium text-slate-700">{f.name}</span>
                                <span className="text-[10px] text-slate-400">({new Date(f.uploadDate).toLocaleDateString()})</span>
                            </div>
                            <button 
                                type="button"
                                onClick={(e) => { 
                                    e.stopPropagation(); 
                                    handleDeleteFile(f.id); 
                                }}
                                className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                                disabled={deletingFileId === f.id}
                                title="Delete File Record"
                            >
                                {deletingFileId === f.id ? <Loader2 className="w-4 h-4 animate-spin text-red-500"/> : <Trash2 className="w-4 h-4"/>}
                            </button>
                        </div>
                    ))}
                    {(!managingMfg.files?.some(f => f.type === 'pricing')) && <p className="text-sm text-slate-400 italic">No pricing files uploaded.</p>}
                 </div>
              </section>

              {/* Options Discovery Audit */}
              <section>
                 <h4 className="font-semibold text-slate-800 mb-2 mt-6">Discovered Options ({managingMfg.options?.length || 0})</h4>
                 <div className="max-h-60 overflow-y-auto border border-slate-200 rounded p-2 text-xs space-y-1">
                     {managingMfg.options?.map(o => (
                         <div key={o.id} className="flex justify-between items-center bg-slate-50 p-1 rounded">
                             <div className="flex flex-col">
                                 <span className="font-medium">{o.name}</span>
                                 <span className="text-slate-400 text-[10px]">{o.category} • {o.section}</span>
                             </div>
                             <span className="font-mono text-slate-500">
                                 {o.pricingType === 'percentage' ? `${(o.price*100).toFixed(1)}%` : `+$${o.price}`}
                             </span>
                         </div>
                     ))}
                     {(!managingMfg.options || managingMfg.options.length === 0) && <p className="text-slate-400">No options discovered yet.</p>}
                 </div>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};