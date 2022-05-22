import axios from "axios";
import fs from "fs";
import stringSimilarity from "string-similarity";
import {
    ChinaAnimeData,
    ChinaAnimeItem,
    ChinaAnimeType,
    ConvertChinaAnime,
    Lang,
    SiteEnum
} from "../types/china_anime_data";
import {
    ConvertGlobalAnime,
    GlobalAnimeData,
    GlobalAnimeItem,
    GlobalAnimeType,
    Season
} from "../types/global_anime_data";
import {Config, IgnoreEntries, ManualRelations} from "../types/config";
import {EtagType, Relation} from "../types/cache";
import {getEtagCache, setEtagCache} from "./cache_util";
import {bangumiClient} from "./bangumi_client";
import {autoLog, autoLogException, LogLevel} from "./log_util";

const config: Config = require("../../config.json");

let china_anime_data: ChinaAnimeData;
let global_anime_data: GlobalAnimeData;
const bgm_id_map: Map<string, ChinaAnimeItem> = new Map();
const mal_id_map: Map<string, GlobalAnimeItem[]> = new Map();
let known_relations: Relation[] = [];

export const manual_relations: ManualRelations = require("../../manual_relations.json");
export const ignore_entries: IgnoreEntries = require("../../ignore_entries.json");

/**
 * @description Load anime data from local cache, and update cache if new data is available.
 *              This should be called before accessing china_anime_data and global_anime_data.
 */
export async function buildDatabase(): Promise<void> {
    if (!fs.existsSync(config.cache_path)) {
        fs.mkdirSync(config.cache_path);
    }

    // Smart update data
    await autoUpdateDatabase();

    // Update exported variables
    china_anime_data = ConvertChinaAnime.toChinaAnimeData(fs.readFileSync(config.cache_path + '/china_anime.json').toString());
    global_anime_data = ConvertGlobalAnime.toGlobalAnimeData(fs.readFileSync(config.cache_path + '/global_anime.json').toString())

    // Build id map
    bgm_id_map.clear();
    mal_id_map.clear();
    china_anime_data.items.forEach(item => {
        const id = getBgmId(item);
        if (!id) {
            // console.warn(`[${loadData.name}] No bgm.tv record for ${item.title}`);
            return;
        }
        bgm_id_map.set(id, item);
    });
    global_anime_data.data.forEach(item => {
        const id = getMalId(item);
        if (!id) {
            // console.warn(`[${loadData.name}] No bgm.tv record for ${item.title}`);
            return;
        }
        if (!mal_id_map.has(id)) {
            mal_id_map.set(id, []);
        }
        (<GlobalAnimeItem[]>mal_id_map.get(id)).push(item);
    });

    // Load cached relations
    if (fs.existsSync(config.cache_path + '/known_relations.json')) {
        known_relations = JSON.parse(fs.readFileSync(config.cache_path + '/known_relations.json').toString());
    }
}

/**
 * @description Get china anime object by bgm.tv id.
 * @param bgm_id bgm.tv id of the anime.
 * @param check_fields Whether to ensure all fields are present when fetching from bgm.tv.
 * @returns The anime data, or null if not found.
 */
export async function getChinaAnimeItem(bgm_id: string, check_fields: boolean = true): Promise<ChinaAnimeItem | null> {
    const cn_anime = bgm_id_map.get(bgm_id);
    if (cn_anime) return cn_anime;

    autoLog(`Bgm id ${bgm_id} not found in database, fetching and building from bgm.tv...`, "getChinaAnimeItem", LogLevel.Debug);

    const bgm_subject = await bangumiClient.getSubjectById(bgm_id);
    if (!bgm_subject) return null;

    // Ensure bgm_subject has all required fields
    if (check_fields && !bgm_subject.date) return null;
    let type: ChinaAnimeType;
    switch (bgm_subject.platform) {
        case "TV":
            type = ChinaAnimeType.Tv;
            break;
        case "OVA":
            type = ChinaAnimeType.Ova;
            break;
        case "WEB":
            type = ChinaAnimeType.Web;
            break;
        case "剧场版":
            type = ChinaAnimeType.Movie;
            break;
        default:
            return null;
    }

    return {
        // Set date to now if date is null
        begin: bgm_subject.date ? new Date(bgm_subject.date) : new Date(),
        end: "",
        lang: Lang.Ja,
        officialSite: "",
        sites: [{site: SiteEnum.Bangumi, id: bgm_id}],
        title: bgm_subject.name,
        titleTranslate: bgm_subject.name_cn ? {"zh-Hans": [bgm_subject.name_cn]} : {},
        type: type,
    };
}


/**
 * @description Get global anime object by myanimelist id.
 * @param mal_id myanimelist id of the anime.
 * @returns The anime data, or null if not found.
 */
export async function getGlobalAnimeItemByMal(mal_id: string): Promise<GlobalAnimeItem | null> {
    let res = mal_id_map.get(mal_id);
    if (res) return res[0];
    return null;
}

/**
 * @description Get global anime object by anilist id. Because this function is not frequently called, performance is not optimized.
 * @param anilist_id anilist id of the anime.
 */
export async function getGlobalAnimeItemByAnilist(anilist_id: string): Promise<GlobalAnimeItem | null> {
    for (let item of global_anime_data.data) {
        let res = item?.sources.find(site => {
            return site.match(/anilist/);
        })?.match(/anime\/(\d+)/)![1];
        if (res == anilist_id) {
            return item;
        }
    }
    return null;
}

/**
 * @description Try to match a China anime object to global object.
 * @param cn China anime object.
 * @param titleSimilarityThreshold Lower bound of title similarity when fuzzy matching.
 * @returns The matched global anime object, or null if not found.
 */
export async function matchChinaToGlobal(cn: ChinaAnimeItem, titleSimilarityThreshold: number = 0.75): Promise<GlobalAnimeItem | null> {
    // First, check known relations
    const bgm_id = getBgmId(cn);
    if (!bgm_id) {
        autoLog(`Failed to find BGM id for "${cn.title}.`, "matchEntry", LogLevel.Warn);
        // incrementProgressBar();
        return null;
    }
    let mal_id = known_relations.find(r => r.bgm_id === bgm_id)?.mal_id;
    if (mal_id) {
        autoLog(`Found known relation for "${cn.title}".`, "matchEntry", LogLevel.Debug);
        // incrementProgressBar();
        return await getGlobalAnimeItemByMal(mal_id);
    }

    // Construct all titles in cn database
    const cnTitles = [cn.title];
    for (const [, names] of Object.entries(cn.titleTranslate)) if (names) cnTitles.push(...names);

    // Fuzzy match titles in global database
    const fuzzyMatch: { anime: GlobalAnimeItem, score: number }[] = [];
    let bestMatch: { anime?: GlobalAnimeItem, score: number } = {score: 0};
    global_anime_data.data.forEach(gl => {
        const glTitles = [gl.title, ...gl.synonyms];
        for (const title of cnTitles) {
            const score = stringSimilarity.findBestMatch(title, glTitles).bestMatch.rating;
            if (score >= titleSimilarityThreshold)
                fuzzyMatch.push({anime: gl, score});
            if (score > bestMatch.score)
                bestMatch = {anime: gl, score};
        }
    });
    fuzzyMatch.sort((a, b) => b.score - a.score);

    // If all fuzzy match results have score below threshold, use the best match
    // In this case, strict mode is enabled to (hopefully) avoid false positive
    let strictMode = false;
    if (fuzzyMatch.length == 0 && bestMatch.anime) {
        fuzzyMatch.push({anime: bestMatch.anime, score: bestMatch.score});
        strictMode = true;
    }

    // Check aired date and format
    for (const {anime, score} of fuzzyMatch) {
        if (!await compareChinaWithGlobal(cn, anime, strictMode)) continue;

        // Store match to relations
        const mal_id = getMalId(anime);
        if (!mal_id) {
            // progressBarLog(`[${matchChinaToGlobal.name}] Failed to find MAL id for "${cn.title}"`);
            continue;
        }
        known_relations.push({
            bgm_id,
            mal_id,
            title: cn.title,
        });

        // Save known relations
        fs.writeFileSync(config.cache_path + '/known_relations.json', JSON.stringify(known_relations, null, 4));

        autoLog(`score=${score}, "${cn.title}" matched to "${anime.title}"`, "matchEntry", LogLevel.Info);
        // incrementProgressBar();
        return anime;
    }

    // incrementProgressBar();
    return null;
}


/**
 * @description Check if the China and global anime are matched.
 * @param china     The china anime item.
 * @param global    The global anime item.
 * @param strictMode    When true, more strict check is performed.
 * @param matchMonth    When true, air date will be checked to month.
 * @param matchFormat    When true, same format will be ensured.
 */
export async function compareChinaWithGlobal(china: ChinaAnimeItem, global: GlobalAnimeItem, strictMode: boolean, matchMonth: boolean = true, matchFormat: boolean = true): Promise<boolean> {
    // If years mismatch, skip
    if (china.begin.getFullYear() != global.animeSeason.year)
        return false;

    // Check season
    const month = china.begin.getMonth() + 1;
    if (matchMonth && global.animeSeason.season !== Season.Undefined) {
        if (strictMode) {
            if (global.animeSeason.season !== Season.Winter && month < 4) return false;
            if (global.animeSeason.season !== Season.Spring && month < 7) return false;
            if (global.animeSeason.season !== Season.Summer && month < 10) return false;
            if (global.animeSeason.season !== Season.Fall && month < 13) return false;
        } else {
            switch (month) {
                case 1:
                case 2:
                    if (global.animeSeason.season !== Season.Winter) return false;
                    break;
                case 3:
                    if (global.animeSeason.season !== Season.Winter && global.animeSeason.season !== Season.Spring) return false;
                    break;
                case 4:
                case 5:
                    if (global.animeSeason.season !== Season.Spring) return false;
                    break;
                case 6:
                    if (global.animeSeason.season !== Season.Spring && global.animeSeason.season !== Season.Summer) return false;
                    break;
                case 7:
                case 8:
                    if (global.animeSeason.season !== Season.Summer) return false;
                    break;
                case 9:
                    if (global.animeSeason.season !== Season.Summer && global.animeSeason.season !== Season.Fall) return false;
                    break;
                case 10:
                case 11:
                    if (global.animeSeason.season !== Season.Fall) return false;
                    break;
                case 12:
                    if (global.animeSeason.season !== Season.Fall && global.animeSeason.season !== Season.Winter) return false;
                    break;
                default:
                    return false;
            }
        }
    }

    // Check format
    let mismatch = false;
    if (matchFormat && global.type !== GlobalAnimeType.Unknown) {
        switch (china.type) {
            case ChinaAnimeType.Tv:
                if (global.type !== GlobalAnimeType.Tv) mismatch = true;
                break;
            case ChinaAnimeType.Web:
                if (global.type !== GlobalAnimeType.Ona) mismatch = true;
                break;
            case ChinaAnimeType.Ova:
                if (global.type !== GlobalAnimeType.Ova && global.type !== GlobalAnimeType.Special)
                    mismatch = true;
                break;
            case ChinaAnimeType.Movie:
                if (global.type !== GlobalAnimeType.Movie) mismatch = true;
                break;
        }
    }
    // Check episode count as a backup
    return !(mismatch && (!strictMode && (await bangumiClient.getSubjectById(<string>getBgmId(china)))?.total_episodes !== global.episodes));
}

/**
 * @description Get bgm id of a china anime object.
 * @param cn An cn anime object.
 */
export function getBgmId(cn: ChinaAnimeItem): string | null {
    // TODO: construct map from cnItem to bgm_id for anime not in database
    return cn.sites.find(s => s.site === SiteEnum.Bangumi)?.id || null;
}

/**
 * @description Get myanimelist id of a global anime object.
 * @param gl An global anime object.
 */
export function getMalId(gl: GlobalAnimeItem): string | null {
    return gl.sources.find(site => {
        return site.match(/myanimelist/)
    })?.match(/anime\/(\d+)/)![1] || null;
}


/**
 * @description Get china anime object from a global anime object.
 * @param malId
 */
export function getAnilistId(malId: string): string | null {
    let gls = mal_id_map.get(malId);
    if (!gls) return null;
    for (let gl of gls) {
        let res = gl?.sources.find(site => {
            return site.match(/anilist/)
        })?.match(/anime\/(\d+)/)![1];
        if (res) return res;
    }
    return null;
}

/**
 * @description Check the version of local anime database cache and update if necessary.
 */
async function autoUpdateDatabase(): Promise<void> {
    // Fetch etag from url
    let china_etag: string;
    let global_etag: string

    try {
        china_etag = (await axios.head(config.china_anime_database_url)).headers['etag'];
        global_etag = (await axios.head(config.global_anime_database_url)).headers['etag'];
    } catch (e) {
        autoLog("Failed to fetch etag from url.", "updateDatabase", LogLevel.Error);
        autoLogException(e as Error);
        return;
    }

    // Update if etag changed
    if (china_etag !== getEtagCache(EtagType.China) || !fs.existsSync(config.cache_path + '/china_anime.json')) {
        let china_data: ChinaAnimeData;
        try {
            autoLog("Updating china_anime database from " + config.china_anime_database_url, "updateDatabase", LogLevel.Info);
            china_data = await axios.get(config.china_anime_database_url).then(res => res.data);
            fs.writeFileSync(config.cache_path + '/china_anime.json', JSON.stringify(china_data));
        } catch (e) {
            autoLog("Unable to fetch china_anime database: ", "updateDatabase", LogLevel.Error);
            autoLogException(e as Error);
        }
        setEtagCache(EtagType.China, china_etag);
    }

    if (global_etag !== getEtagCache(EtagType.Global) || !fs.existsSync(config.cache_path + '/global_anime.json')) {
        let global_data: GlobalAnimeData;
        try {
            autoLog("Updating global_anime database from " + config.global_anime_database_url, "updateDatabase", LogLevel.Info);
            global_data = await axios.get(config.global_anime_database_url).then(res => res.data);
            fs.writeFileSync(config.cache_path + '/global_anime.json', JSON.stringify(global_data));
        } catch (e) {
            autoLog("Unable to fetch global_anime database: ", "updateDatabase", LogLevel.Error);
            autoLogException(e as Error);
        }
        setEtagCache(EtagType.Global, global_etag);
    }
}

// Update cache every 12 hours
// const schedule = require("node-schedule");
// schedule.scheduleJob('0 */12 * * *', loadData);

export {china_anime_data, global_anime_data};
