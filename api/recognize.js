// api/recognize.js (Vercel Serverless Function)
const axios = require('axios');

// Access Token 存储和过期时间。
// 注意：在无服务器环境中，此状态可能在不同调用之间重置，
// 但对于本教程的简单用例来说已足够。
let accessToken = '';
let tokenExpiryTime = 0;

// 获取或刷新百度 AI Access Token 的函数
async function getAccessToken() {
    // 如果 Access Token 存在且未过期，则直接返回
    if (accessToken && Date.now() < tokenExpiryTime) {
        return accessToken;
    }

    try {
        // 从环境变量中获取百度 API 凭证
        const BAIDU_API_KEY = process.env.BAIDU_API_KEY;
        const BAIDU_SECRET_KEY = process.env.BAIDU_SECRET_KEY;

        if (!BAIDU_API_KEY || !BAIDU_SECRET_KEY) {
            throw new Error('Baidu API Key 或 Secret Key 环境变量未设置。');
        }

        const response = await axios.get(
            `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${BAIDU_API_KEY}&client_secret=${BAIDU_SECRET_KEY}`
        );
        accessToken = response.data.access_token;
        // 提前 300 秒（5分钟）刷新 Access Token，以防过期
        tokenExpiryTime = Date.now() + (response.data.expires_in - 300) * 1000;
        console.log('Access Token 已刷新。');
        return accessToken;
    } catch (error) {
        console.error('获取 Access Token 失败:', error.response ? error.response.data : error.message);
        throw new Error('从百度获取 Access Token 失败。请检查您的 API 密钥和网络连接。');
    }
}

// 调用百度图像识别API的通用函数
async function callBaiduAPI(endpoint, base64Image) {
    const token = await getAccessToken();
    const baiduApiUrl = `https://aip.baidubce.com/rest/2.0/image-classify/${endpoint}?access_token=${token}`;
    const base64WithoutPrefix = base64Image.split(',')[1]; // 移除 "data:image/jpeg;base64," 等前缀

    const response = await axios.post(baiduApiUrl, `image=${encodeURIComponent(base64WithoutPrefix)}`, {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json'
        }
    });

    return response.data;
}

// 融合多个API结果的函数
function mergeResults(results) {
    const merged = {};
    const allItems = [];

    // 收集所有识别结果
    results.forEach(result => {
        // 处理多主体检测API的结果
        if (result.result && Array.isArray(result.result)) {
            result.result.forEach(item => {
                // 多主体检测API返回的字段可能不同
                const key = item.keyword || item.root || item.name || item.class || '未知物品';
                const score = item.score || item.confidence || (item.baike_info?.image_url ? 0.8 : 0.5);
                
                if (!merged[key]) {
                    merged[key] = {
                        keyword: key,
                        root: item.root || key,
                        score: score,
                        count: 1,
                        sources: [],
                        // 多主体检测API可能提供位置信息
                        location: item.location || null
                    };
                } else {
                    merged[key].score = Math.max(merged[key].score, score);
                    merged[key].count += 1;
                    // 如果新结果有位置信息，保留它
                    if (item.location && !merged[key].location) {
                        merged[key].location = item.location;
                    }
                }
                
                if (item.baike_info?.image_url) {
                    merged[key].sources.push('baike');
                }
            });
        }
        
        // 处理多主体检测API的特殊返回格式
        if (result.objects && Array.isArray(result.objects)) {
            result.objects.forEach(item => {
                const key = item.class || item.name || '未知物品';
                const score = item.confidence || item.score || 0.5;
                
                if (!merged[key]) {
                    merged[key] = {
                        keyword: key,
                        root: key,
                        score: score,
                        count: 1,
                        sources: ['multi_object_detect'],
                        location: item.location || null
                    };
                } else {
                    merged[key].score = Math.max(merged[key].score, score);
                    merged[key].count += 1;
                    merged[key].sources.push('multi_object_detect');
                }
            });
        }
    });

    // 转换为数组并按置信度排序
    Object.values(merged).forEach(item => {
        // 根据出现次数和置信度计算最终分数
        // 多主体检测API的结果给予更高权重
        const sourceWeight = item.sources.includes('multi_object_detect') ? 1.2 : 1.0;
        const finalScore = item.score * (1 + item.count * 0.1) * sourceWeight;
        allItems.push({
            ...item,
            finalScore: finalScore
        });
    });

    // 按最终分数排序，返回前10个结果
    return allItems
        .sort((a, b) => b.finalScore - a.finalScore)
        .slice(0, 10)
        .map(item => ({
            keyword: item.keyword,
            root: item.root,
            score: item.finalScore,
            location: item.location
        }));
}

// Serverless Function 的主处理函数
module.exports = async (req, res) => {
    // Vercel 会自动解析 POST 请求的 JSON 正文，并处理相同项目内的 API 路由的 CORS。

    if (req.method !== 'POST') {
        return res.status(405).json({ error: '方法不允许', message: '仅支持 POST 请求用于图像识别。' });
    }

    const { image } = req.body;

    if (!image) {
        return res.status(400).json({ error: '请求错误', message: '请求正文中未提供图片数据。' });
    }

    try {
        // 并行调用多个百度API接口以提高识别精度
        const apiCalls = [
            // 图像多主体检测（高精度，推荐）
            callBaiduAPI('v1/multi_object_detect', image).catch(err => ({ error: 'multi_object_detect', message: err.message })),
            // 通用物体识别（基础）
            callBaiduAPI('v2/advanced_general', image).catch(err => ({ error: 'advanced_general', message: err.message })),
            // 图像主体检测（更精准）
            callBaiduAPI('v1/object_detect', image).catch(err => ({ error: 'object_detect', message: err.message })),
            // 动物识别（如果是动物相关）
            callBaiduAPI('v1/animal', image).catch(err => ({ error: 'animal', message: err.message })),
            // 植物识别（如果是植物相关）
            callBaiduAPI('v1/plant', image).catch(err => ({ error: 'plant', message: err.message }))
        ];

        const results = await Promise.allSettled(apiCalls);
        
        // 过滤成功的结果
        const successfulResults = results
            .filter(result => result.status === 'fulfilled' && !result.value.error)
            .map(result => result.value);

        if (successfulResults.length === 0) {
            throw new Error('所有API调用都失败了');
        }

        // 融合多个API的结果
        const mergedResult = mergeResults(successfulResults);

        // 返回融合后的结果
        res.status(200).json({
            result: mergedResult,
            apiCount: successfulResults.length,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('图像识别失败:', error.response ? error.response.data : error.message);
        const errorMessage = error.message || '图像识别过程中发生未知错误。';
        const errorDetails = error.response ? error.response.data : {};
        res.status(500).json({ error: '内部服务器错误', message: `图像识别失败: ${errorMessage}`, details: errorDetails });
    }
};

