const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

/**
 * Service để tương tác với Facebook Graph API
 */
class FacebookApiService {
  constructor(pageId, pageAccessToken) {
    this.pageId = pageId;
    this.accessToken = pageAccessToken;
    this.apiVersion = 'v19.0';
    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}`;
  }

  /**
   * Tải video lên Fanpage
   * @param {string} videoPath - Đường dẫn tuyệt đối tới file video trên máy
   * @param {string} description - Nội dung mô tả (Caption) của video
   * @returns {Promise<string>} - Trả về ID của bài viết (video_id)
   */
  async uploadVideo(videoPath, description) {
    console.log('Bắt đầu tải video lên Facebook...');
    try {
      const url = `${this.baseUrl}/${this.pageId}/videos`;
      
      const form = new FormData();
      form.append('access_token', this.accessToken);
      form.append('description', description);
      form.append('source', fs.createReadStream(videoPath));

      const response = await axios.post(url, form, {
        headers: {
          ...form.getHeaders(),
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });

      console.log('Tải video thành công! Video ID:', response.data.id);
      return response.data.id; // Đây chính là ID bài viết
    } catch (error) {
      console.error('Lỗi khi tải video lên Facebook:');
      if (error.response) {
        console.error(error.response.data);
      } else {
        console.error(error.message);
      }
      throw error;
    }
  }

  /**
   * Tự động bình luận vào một bài viết
   * @param {string} postId - ID của bài viết (lấy từ hàm uploadVideo)
   * @param {string} message - Nội dung bình luận
   * @returns {Promise<string>} - Trả về ID của bình luận
   */
  async postComment(postId, message) {
    console.log(`Bắt đầu bình luận vào bài viết ${postId}...`);
    try {
      const url = `${this.baseUrl}/${postId}/comments`;
      
      const response = await axios.post(url, null, {
        params: {
          access_token: this.accessToken,
          message: message
        }
      });

      console.log('Bình luận thành công! Comment ID:', response.data.id);
      return response.data.id;
    } catch (error) {
      console.error('Lỗi khi bình luận:');
      if (error.response) {
        console.error(error.response.data);
      } else {
        console.error(error.message);
      }
      throw error;
    }
  }

  /**
   * Hàm tổng hợp: Đăng video xong tự động bình luận ngay
   * @param {string} videoPath - Đường dẫn file video
   * @param {string} videoCaption - Nội dung mô tả video
   * @param {string} commentText - Nội dung bình luận tự động
   */
  async publishAndComment(videoPath, videoCaption, commentText) {
    try {
      // Bước 1: Đăng video
      const postId = await this.uploadVideo(videoPath, videoCaption);
      
      // Bước 2: Bình luận vào video vừa đăng (chỉ thực hiện nếu có commentText)
      if (commentText && commentText.trim() !== '') {
        try {
          // Chờ một chút để Facebook xử lý video (khoảng 3 giây)
          await new Promise(resolve => setTimeout(resolve, 3000));
          await this.postComment(postId, commentText);
          console.log('✅ Hoàn thành đăng video và bình luận!');
        } catch (commentError) {
          console.error('⚠️ Đăng bình luận thất bại (nhưng video đã đăng thành công):', commentError.message);
          return { 
            success: true, 
            postId, 
            warning: 'Đã đăng video thành công, nhưng không thể bình luận tự động do thiếu quyền của Facebook token.' 
          };
        }
      } else {
        console.log('✅ Hoàn thành đăng video (không có bình luận).');
      }
      
      return { success: true, postId };
    } catch (error) {
      console.error('❌ Quy trình thất bại!');
      return { success: false, error: error.message };
    }
  }
}

module.exports = FacebookApiService;
