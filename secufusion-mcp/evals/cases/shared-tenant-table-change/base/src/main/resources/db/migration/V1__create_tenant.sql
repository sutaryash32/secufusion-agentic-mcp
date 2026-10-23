CREATE TABLE tenant (
  id VARCHAR(36) PRIMARY KEY,
  company_name VARCHAR(255) NOT NULL,
  parent_id VARCHAR(36),
  status VARCHAR(32) NOT NULL
);
