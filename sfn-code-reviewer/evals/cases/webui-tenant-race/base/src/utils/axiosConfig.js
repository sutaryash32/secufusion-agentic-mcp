import axios from 'axios';

const apiClient = axios.create({ timeout: 30000 });
export default apiClient;
