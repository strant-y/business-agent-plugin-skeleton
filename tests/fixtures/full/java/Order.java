package com.example.order;

import jakarta.persistence.*;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

@Entity
@Table(name = "orders")
public class Order {

  @Id
  @Column(name = "id")
  private Long id;

  @NotNull
  @Column(name = "total", nullable = false)
  private BigDecimal total;

  @NotBlank
  @Size(min = 3, max = 20)
  private String status;

  @Valid
  private Customer customerProfile;

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
