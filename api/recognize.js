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
        const token = await getAccessToken();

        const baiduApiUrl = `https://aip.baidubce.com/rest/2.0/image-classify/v2/advanced_general?access_token=${token}`;
        const base64WithoutPrefix = image.split(',')[1]; // 移除 "data:image/jpeg;base64," 等前缀

        const baiduResponse = await axios.post(baiduApiUrl, `image=${encodeURIComponent(base64WithoutPrefix)}`, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json'
            }
        });

        // 将百度 API 的响应直接返回给前端
        res.status(200).json(baiduResponse.data);
    } catch (error) {
        console.error('图像识别失败:', error.response ? error.response.data : error.message);
        const errorMessage = error.message || '图像识别过程中发生未知错误。';
        const errorDetails = error.response ? error.response.data : {};
        res.status(500).json({ error: '内部服务器错误', message: `图像识别失败: ${errorMessage}`, details: errorDetails });
    }
};

