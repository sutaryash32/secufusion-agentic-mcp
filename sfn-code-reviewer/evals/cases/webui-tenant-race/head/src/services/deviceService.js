import apiClient from '../utils/axiosConfig';
import { API } from '../utils/apiEndpoints';

const deviceService = {
  async list(tenantId) {
    const res = await apiClient.get(API.devices(tenantId));
    return res.data.data;
  },
};
export default deviceService;
