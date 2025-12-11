-- db/schema.sql
-- Core schema for MyPunctoo

-- Companies using MyPunctoo
CREATE TABLE companies (
    id               SERIAL PRIMARY KEY,
    company_code     VARCHAR(32) UNIQUE NOT NULL,      -- e.g. C-000127
    name             VARCHAR(255) NOT NULL,
    vat_number       VARCHAR(64),                      -- e.g. BE 0123.456.789
    registered_address TEXT,
    billing_address    TEXT,
    billing_email      VARCHAR(255),
    billing_reference  VARCHAR(255),                   -- PO / cost center (optional)
    estimated_user_count INTEGER,
    created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Subscription per company
CREATE TABLE subscriptions (
    id                 SERIAL PRIMARY KEY,
    company_id         INTEGER NOT NULL REFERENCES companies(id),
    subscription_number VARCHAR(32) UNIQUE NOT NULL,   -- SUB-000127
    plan_code          VARCHAR(64) NOT NULL,          -- e.g. monthly-unlimited
    status             VARCHAR(16) NOT NULL CHECK (status IN ('active','inactive','cancelled')),
    start_date         DATE NOT NULL,
    end_date           DATE,
    cancelled_at       TIMESTAMP WITH TIME ZONE,
    created_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Physical locations where QR plates are mounted
CREATE TABLE locations (
    id           SERIAL PRIMARY KEY,
    company_id   INTEGER NOT NULL REFERENCES companies(id),
    name         VARCHAR(255) NOT NULL,       -- e.g. "Warehouse entrance"
    address      TEXT,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- QR codes (IN / OUT) linked to locations
CREATE TABLE qr_codes (
    id           SERIAL PRIMARY KEY,
    location_id  INTEGER NOT NULL REFERENCES locations(id),
    qr_token     VARCHAR(128) UNIQUE NOT NULL,        -- random, not guessable
    direction    VARCHAR(8) NOT NULL CHECK (direction IN ('in','out')),
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Portal user accounts (admins at the client side)
CREATE TABLE client_portal_users (
    id            SERIAL PRIMARY KEY,
    company_id    INTEGER NOT NULL REFERENCES companies(id),
    email         VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name     VARCHAR(255),
    role          VARCHAR(32) NOT NULL DEFAULT 'admin', -- admin / viewer / etc.
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Employees that can clock in/out
CREATE TABLE employees (
    id                 SERIAL PRIMARY KEY,
    company_id         INTEGER NOT NULL REFERENCES companies(id),
    employee_code      VARCHAR(64) UNIQUE NOT NULL,   -- internal employee ID
    first_name         VARCHAR(128) NOT NULL,
    last_name          VARCHAR(128) NOT NULL,
    email              VARCHAR(255),
    phone              VARCHAR(64),
    start_date         DATE NOT NULL,
    end_date           DATE,
    status             VARCHAR(16) NOT NULL CHECK (status IN ('active','inactive')),
    created_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Punch events (check-in / check-out)
CREATE TABLE punches (
    id              SERIAL PRIMARY KEY,
    employee_id     INTEGER NOT NULL REFERENCES employees(id),
    company_id      INTEGER NOT NULL REFERENCES companies(id),
    location_id     INTEGER REFERENCES locations(id),
    qr_code_id      INTEGER REFERENCES qr_codes(id),
    direction       VARCHAR(8) NOT NULL CHECK (direction IN ('in','out')),
    punched_at      TIMESTAMP WITH TIME ZONE NOT NULL,
    device_token    VARCHAR(255),        -- identifies the phone (not required but useful)
    user_agent      TEXT,
    ip_address      INET,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Invoices
CREATE TABLE invoices (
    id                 SERIAL PRIMARY KEY,
    company_id         INTEGER NOT NULL REFERENCES companies(id),
    invoice_number     VARCHAR(64) UNIQUE NOT NULL,
    subscription_id    INTEGER REFERENCES subscriptions(id),
    period_start       DATE NOT NULL,
    period_end         DATE NOT NULL,
    currency           VARCHAR(8) NOT NULL DEFAULT 'EUR',
    amount_ex_vat      NUMERIC(12,2) NOT NULL,
    vat_rate           NUMERIC(5,2) NOT NULL,  -- e.g. 21.00
    amount_inc_vat     NUMERIC(12,2) NOT NULL,
    status             VARCHAR(16) NOT NULL CHECK (status IN ('draft','sent','paid','overdue')),
    issued_at          TIMESTAMP WITH TIME ZONE,
    due_at             TIMESTAMP WITH TIME ZONE,
    created_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE invoice_lines (
    id           SERIAL PRIMARY KEY,
    invoice_id   INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    description  TEXT NOT NULL,
    quantity     NUMERIC(10,2) NOT NULL DEFAULT 1,
    unit_price   NUMERIC(12,2) NOT NULL,
    amount       NUMERIC(12,2) NOT NULL
);

-- Simple index examples
CREATE INDEX idx_punches_company_date ON punches (company_id, punched_at DESC);
CREATE INDEX idx_employees_company_status ON employees (company_id, status);
CREATE INDEX idx_qr_codes_token ON qr_codes (qr_token);
