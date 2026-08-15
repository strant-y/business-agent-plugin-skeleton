package com.example.order;

import jakarta.persistence.*;

@Entity
@Table(name = "orders")
public class Order {

  @Id
  @Column(name = "id")
  private Long id;

  @Column(name = "total", nullable = false)
  private BigDecimal total;

  @ManyToOne
  @JoinColumn(name = "customer_id")
  private Customer customer;

  @OneToMany(mappedBy = "order")
  private List<OrderItem> items;

  public Long getId() { return id; }
  public void setId(Long id) { this.id = id; }
  public BigDecimal getTotal() { return total; }
  public void setTotal(BigDecimal total) { this.total = total; }
  public String getStatus() { return "APPROVED"; }
}
