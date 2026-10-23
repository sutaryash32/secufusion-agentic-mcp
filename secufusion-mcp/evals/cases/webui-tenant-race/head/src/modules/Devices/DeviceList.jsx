import { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { List, ListItem, ListItemText } from '@mui/material';
import deviceService from '../../services/deviceService';

export default function DeviceList() {
  const currentUser = useSelector((s) => s.auth.currentUser);
  const [devices, setDevices] = useState([]);

  useEffect(() => {
    deviceService
      .list(currentUser.tenantId)
      .then(setDevices)
      .catch(() => setDevices([]));
  }, []);

  return (
    <List>
      {devices.map((d) => (
        <ListItem key={d.id}><ListItemText primary={d.deviceName} secondary={d.lastSeenAt} /></ListItem>
      ))}
    </List>
  );
}
